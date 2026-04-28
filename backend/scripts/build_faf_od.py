import csv
import json
import os
import urllib.request
import zipfile
from collections import defaultdict


def main():
    zip_path = os.path.join(os.environ.get("TEMP", ""), "faf5_2018_2024.zip")
    if not os.path.exists(zip_path):
      raise SystemExit(f"Missing FAF zip in TEMP: {zip_path}")

    regions_url = (
        "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/"
        "NTAD_Freight_Analysis_Framework_Regions/FeatureServer/0/query"
        "?where=1%3D1&outFields=FAF_Zone,FAF_Zone_D,CFS17_NAME,INTPTLAT,INTPTLON"
        "&returnGeometry=false&f=json"
    )
    obj = json.loads(urllib.request.urlopen(regions_url, timeout=120).read().decode("utf-8"))
    centroids = {}
    for f in obj.get("features", []):
        a = f.get("attributes", {})
        z = str(a.get("FAF_Zone", "")).strip()
        if not z:
            continue
        try:
            lat = float(a.get("INTPTLAT"))
            lon = float(a.get("INTPTLON"))
        except Exception:
            continue
        centroids[z] = {
            "lon": lon,
            "lat": lat,
            "name": a.get("FAF_Zone_D") or a.get("CFS17_NAME") or f"FAF Zone {z}",
        }

    agg = defaultdict(float)
    with zipfile.ZipFile(zip_path) as zf:
        with zf.open("FAF5.7.1_2018-2024.csv") as fh:
            rows = csv.DictReader((line.decode("utf-8", "replace") for line in fh))
            for row in rows:
                if row.get("dms_mode") != "1":
                    continue
                o = (row.get("dms_orig") or "").strip()
                d = (row.get("dms_dest") or "").strip()
                if not o or not d or o == d:
                    continue
                try:
                    tons = float(row.get("tons_2024") or 0)
                except Exception:
                    tons = 0.0
                if tons <= 0:
                    continue
                agg[(o, d)] += tons

    items = sorted(agg.items(), key=lambda kv: kv[1], reverse=True)
    top_n = int(os.environ.get("FAF_OD_TOP_N", "7000"))
    min_tons = float(os.environ.get("FAF_OD_MIN_TONS_2024", "40"))

    features = []
    for i, ((o, d), tons) in enumerate(items):
        if i >= top_n or tons < min_tons:
            break
        co = centroids.get(o)
        cd = centroids.get(d)
        if not co or not cd:
            continue
        features.append(
            {
                "type": "Feature",
                "id": i + 1,
                "properties": {
                    "id": i + 1,
                    "origin_zone": o,
                    "destination_zone": d,
                    "origin_name": co["name"],
                    "destination_name": cd["name"],
                    "tons_2024_ktons": round(tons, 3),
                    "mode": "Truck (FAF5 OD 2024)",
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[co["lon"], co["lat"]], [cd["lon"], cd["lat"]]],
                },
            }
        )

    out = {"type": "FeatureCollection", "features": features}
    out_path = os.path.join(
        os.path.dirname(__file__), "..", "data", "derived", "faf5_truck_od_2024.geojson"
    )
    out_path = os.path.abspath(out_path)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"Wrote {out_path} features={len(features)}")


if __name__ == "__main__":
    main()
