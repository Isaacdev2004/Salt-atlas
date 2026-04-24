import {
  getApiBase,
  apiFetch,
  fetchRegionsWithRetry,
  getSessionToken,
  setSessionToken,
  clearSessionToken,
} from "./config/api";
import { useEffect, useRef, useState, useCallback } from "react";

/* Constants */

const TILESET_URL =
  import.meta.env.VITE_MAPBOX_TILESET_URL ?? "mapbox://saltstrategy.1zigf4lu";
const SOURCE_LAYER =
  import.meta.env.VITE_MAPBOX_COUNTY_SOURCE_LAYER ?? "counties-6vgku6";
const DEFAULT_CENTER = [-98, 39];
const DEFAULT_ZOOM = 3;

const layerLabel = {
  none: "None",
  score_opportunity: "Opportunity Score",
  score_population: "Population",
  score_income: "Median Income",
  score_business: "Business Count",
  score_transit: "Transit supply (county)",
};

/** Line colors aligned with USDOT National Transit Map route symbology */
const NTM_ROUTE_LINE_COLOR = [
  "match",
  ["coalesce", ["get", "route_type_text"], ""],
  "Bus",
  "#bab1b1",
  "Commuter Rail",
  "#a11e06",
  "Heavy Rail",
  "#a11e06",
  "Intercity Rail",
  "#4a0a0a",
  "Light Rail",
  "#cb3b09",
  "Streetcar",
  "#cb3b09",
  "Cable Tram",
  "#8b5cf6",
  "Ferry",
  "#0284c7",
  "Funicular",
  "#64748b",
  "Gondola",
  "#64748b",
  "Monorail",
  "#64748b",
  "Trolleybus",
  "#6b7280",
  "Air Service",
  "#0ea5e9",
  "Other",
  "#525252",
  "#6b7280",
];

/** Subset for legend (labels must stay in sync with NTM_ROUTE_LINE_COLOR) */
const NTM_ROUTE_LEGEND = [
  { label: "Bus", color: "#bab1b1" },
  { label: "Commuter / heavy rail", color: "#a11e06" },
  { label: "Intercity rail", color: "#4a0a0a" },
  { label: "Light rail / streetcar", color: "#cb3b09" },
  { label: "Ferry", color: "#0284c7" },
  { label: "Other / trolley / tram", color: "#6b7280" },
];

const POI_CONFIG = {
  airports: {
    label: "Airports",
    color: "#ef4444",
    endpoint: "/api/airports",
    kind: "cluster",
    cluster: true,
  },
  ports: {
    label: "Ports",
    color: "#0ea5e9",
    endpoint: "/api/ports",
    kind: "cluster",
    cluster: true,
  },
  rail: {
    label: "Rail Terminals",
    color: "#a855f7",
    endpoint: "/api/rail",
    kind: "cluster",
    cluster: true,
  },
  warehouses: {
    label: "Warehouses",
    color: "#22c55e",
    endpoint: "/api/warehouses",
    kind: "cluster",
    cluster: true,
  },
  manufacturing: {
    label: "Manufacturing",
    color: "#eab308",
    endpoint: "/api/manufacturing",
    kind: "cluster",
    cluster: true,
  },
  ntd_reporters_2024: {
    label: "National Transit Database Reporters 2024",
    color: "#b42318",
    endpoint: "/api/ntd_reporters_2024",
    kind: "cluster",
    cluster: true,
  },
  ntm_routes: {
    label: "National Transit Map Routes",
    color: "#6b7280",
    endpoint: "/api/ntm_routes",
    kind: "line",
    cluster: false,
  },
  fta_admin_boundaries: {
    label: "FTA Administrative Boundaries (Urbanized Areas 2020)",
    color: "rgba(196,160,80,0.35)",
    endpoint: "/api/fta_admin_boundaries",
    kind: "fill",
    cluster: false,
    fillColor: "#c4a050",
    fillOpacity: 0.26,
    fillOutlineColor: "#5c4810",
  },
};

/* Formatters */

const fmtNum = (n) => {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US").format(Math.round(n));
};
const fmtNumFull = (n) => {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
};
const fmtCurrency = (n) => {
  if (n == null || isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
};

const poiPopupEsc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const getScoreLabel = (s) =>
  s >= 0.75 ? "Strong" : s >= 0.5 ? "Moderate" : s >= 0.25 ? "Limited" : "Weak";

/* Filter config */

const FILTER_CONFIG = {
  demographics: ["population"],
  economic: ["median_income", "business_count"],
};

const FILTER_META = {
  population: {
    label: "Population",
    sub: "Total residents per region",
    fmt: fmtNum,
    prop: "raw_population",
  },
  median_income: {
    label: "Median Income",
    sub: "Annual household income",
    fmt: fmtCurrency,
    prop: "raw_median_income",
  },
  business_count: {
    label: "Business Count",
    sub: "Registered entities per region",
    fmt: fmtNum,
    prop: "raw_business_count",
  },
};

/* Choropleth */

const CHORO_STOPS = [
  0,
  "rgba(219,234,254,0.15)",
  0.1,
  "rgba(191,219,254,0.55)",
  0.3,
  "rgba(147,197,253,0.75)",
  0.5,
  "rgba(96,165,250,0.85)",
  0.7,
  "rgba(37,99,235,0.90)",
  0.9,
  "rgba(30,58,138,0.95)",
  1,
  "rgba(15,23,83,1.00)",
];

/** Opaque blues so the transit choropleth reads on the light Mapbox basemap */
const TRANSIT_CHORO_STOPS = [
  0,
  "#dbeafe",
  0.15,
  "#93c5fd",
  0.35,
  "#60a5fa",
  0.55,
  "#3b82f6",
  0.75,
  "#1d4ed8",
  0.92,
  "#1e3a8a",
  1,
  "#172554",
];

/*
 * buildFillColor - Mapbox expression for the fill layer.
 *
 * Data lives in feature-state (injected after API load).
 * Score props are keyed as: fs_score_opportunity, fs_score_population, etc.
 * Filter visibility is done via fill-opacity, not fill-color.
 *
 * Priority: no-data → selected → hover → choropleth
 */
const buildFillColor = (scoreKey) => {
  const fsScore = `fs_${scoreKey}`;
  const stops = scoreKey === "score_transit" ? TRANSIT_CHORO_STOPS : CHORO_STOPS;

  return [
    "case",
    ["!", ["boolean", ["feature-state", "hasData"], false]],
    "#d1d5db",
    ["boolean", ["feature-state", "selected"], false],
    "#c4a050",
    ["boolean", ["feature-state", "hover"], false],
    "#facc15",
    [
      "interpolate",
      ["linear"],
      ["coalesce", ["feature-state", fsScore], 0],
      ...stops,
    ],
  ];
};

/*  Help steps */

const HELP_STEPS = [
  {
    title: "How to Use Salt Atlas",
    body: (
      <>
        <p>
          The Atlas helps you identify high-opportunity regions across the U.S.
        </p>
        <p>
          Use layers, filters, and selection tools to explore and export
          insights.
        </p>
      </>
    ),
  },
  {
    title: "Map Navigation",
    body: (
      <>
        <p>Use your mouse or trackpad to move around the map.</p>
        <ul className="list-disc ml-4">
          <li>Scroll to zoom in/out</li>
          <li>Click + drag to move</li>
        </ul>
        <p>
          You can also use the <b>+ / − zoom controls</b> on the map.
        </p>
      </>
    ),
  },
  {
    title: "Layers",
    body: (
      <>
        <p>
          Select a layer at the top (e.g. <b>Opportunity Score</b>).
        </p>
        <p>This controls how regions are colored.</p>
      </>
    ),
  },
  {
    title: "Filters",
    body: (
      <>
        <p>Use the sliders to refine results:</p>
        <ul className="list-disc ml-4">
          <li>Population</li>
          <li>Median Income</li>
          <li>Business Count</li>
          <li>
            Counties with transit agencies (optional; uses county rollups, not
            the live USDOT map layers)
          </li>
        </ul>
        <p>Adjust both minimum and maximum values.</p>
      </>
    ),
  },
  {
    title: "Infrastructure (USDOT)",
    body: (
      <>
        <p>
          Open <b>Infrastructure</b> to toggle live layers from the same ArcGIS
          services as the USDOT National Transit Map:{" "}
          <b>NTD Reporters 2024</b>, <b>National Transit Map Routes</b>, and{" "}
          <b>FTA Administrative Boundaries</b> (Urbanized Areas 2020).
        </p>
        <p className="text-xs text-gray-500 mt-2">
          The first toggle may take a few seconds while geometry is downloaded
          and cached.
        </p>
      </>
    ),
  },
  {
    title: "Select Mode",
    body: (
      <>
        <p>
          Enable <b>Select</b> to manually choose regions.
        </p>
        <p>Click a region to select it. Click again to remove it.</p>
      </>
    ),
  },
  {
    title: "Top 20",
    body: (
      <>
        <p>
          <b>Top 20</b> highlights the highest scoring regions based on the
          active layer instantly.
        </p>
        <p>You can still manually adjust selections after.</p>
      </>
    ),
  },
  {
    title: "Right Panel",
    body: (
      <>
        <p>Click any region to view detailed insights.</p>
        <p>This panel shows metrics like population, income, and score.</p>
      </>
    ),
  },
  {
    title: "Map View (Eye Icon)",
    body: (
      <>
        <p>
          Use the <b>eye icon 👁</b> to toggle a clean map view.
        </p>
        <p>This hides interface elements so you can focus fully on the map.</p>
      </>
    ),
  },
  {
    title: "Infrastructure Toggle (✈ INFRA)",
    body: (
      <>
        <p>
          Use the <b>✈ INFRA</b> button to toggle infrastructure layers.
        </p>
        <p>This shows airports, ports, rail, warehouses, and more.</p>
      </>
    ),
  },
  {
    title: "Export",
    body: (
      <>
        <p>
          Click <b>Export CSV ↓</b> to download selected regions.
        </p>
      </>
    ),
  },
  {
    title: "Reset",
    body: (
      <>
        <p>
          Use <b>Reset</b> to clear everything and start fresh.
        </p>
      </>
    ),
  },
];

/*  useIsDesktop  */
// Tracks whether we are at sm (640px) breakpoint or above.
// Using a real resize listener means the value stays accurate across
// mobile↔desktop DevTools transitions and real resizes.
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 640);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const handler = (e) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isDesktop;
}

/* 
   Small reusable UI components
 */

function SaltLogo({ pulse = false, size = "md" }) {
  const dim = size === "sm" ? "w-20 h-20" : "w-28 h-28";
  return (
    <img
      src="/salt_logo.png"
      alt="Salt Atlas"
      className={`${dim} object-contain ${pulse ? "animate-pulse-logo" : ""}`}
      onError={(e) => {
        e.target.style.display = "none";
        if (e.target.nextSibling) e.target.nextSibling.style.display = "flex";
      }}
    />
  );
}
function SaltLogoFallback({ size = "md" }) {
  const dim = size === "sm" ? "w-8 h-8 text-sm" : "w-16 h-16 text-2xl";
  return (
    <div
      className={`${dim} rounded-full border border-[#c4a050] items-center justify-center text-[#c4a050]`}
      style={{ display: "none" }}
    >
      ✦
    </div>
  );
}

function Toast({ message, visible }) {
  return (
    <div
      className="fixed bottom-8 left-1/2 z-[9999] pointer-events-none flex items-center gap-2 max-w-[90vw] sm:max-w-sm break-words whitespace-normal bg-[#0d1f35] text-[#f0ece3] border border-[hsla(41,50%,54%,0)] px-5 py-2.5 rounded-md shadow-2xl font-serif text-sm tracking-widest transition-all duration-300"
      style={{
        opacity: visible ? 1 : 0,
        transform: `translateX(-50%) translateY(${visible ? "0" : "0.5rem"})`,
      }}
    >
      <span className="text-[#c4a050]">◆</span>
      {message}
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="w-10 h-10 rounded-full border-2 border-[rgba(13,31,53,0.15)] border-t-[#0d1f35] animate-spin-custom" />
      <div className="text-xs tracking-[0.22em] uppercase text-gray-500">
        Loading Atlas…
      </div>
    </div>
  );
}

function ScoreRing({ score01 }) {
  const pct = Math.min(Math.max(score01 ?? 0, 0), 1);
  const r = 28,
    circ = 2 * Math.PI * r;
  const rLg = 34,
    circLg = 2 * Math.PI * rLg;
  return (
    <div className="relative w-[72px] h-[72px] lg:w-[88px] lg:h-[88px] shrink-0">
      <svg
        width="72"
        height="72"
        className="block lg:hidden"
        style={{ transform: "rotate(-90deg)" }}
      >
        <circle
          cx="36"
          cy="36"
          r={r}
          fill="none"
          stroke="rgba(196,160,80,0.15)"
          strokeWidth="5"
        />
        <circle
          cx="36"
          cy="36"
          r={r}
          fill="none"
          stroke="url(#scoreGrad)"
          strokeWidth="5"
          strokeDasharray={`${pct * circ} ${circ}`}
          strokeLinecap="round"
        />
        <defs>
          <linearGradient id="scoreGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#1e3a8a" />
            <stop offset="100%" stopColor="#c4a050" />
          </linearGradient>
        </defs>
      </svg>
      <svg
        width="88"
        height="88"
        className="hidden lg:block"
        style={{ transform: "rotate(-90deg)" }}
      >
        <circle
          cx="44"
          cy="44"
          r={rLg}
          fill="none"
          stroke="rgba(196,160,80,0.15)"
          strokeWidth="6"
        />
        <circle
          cx="44"
          cy="44"
          r={rLg}
          fill="none"
          stroke="url(#scoreGradLg)"
          strokeWidth="6"
          strokeDasharray={`${pct * circLg} ${circLg}`}
          strokeLinecap="round"
        />
        <defs>
          <linearGradient id="scoreGradLg" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#1e3a8a" />
            <stop offset="100%" stopColor="#c4a050" />
          </linearGradient>
        </defs>
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-serif font-bold text-lg lg:text-xl text-[#0d1f35]">
        {Math.round(pct * 100)}
      </span>
    </div>
  );
}

function MiniBar({ value01 }) {
  const w = Math.min(Math.max(value01 ?? 0, 0), 1) * 100;
  return (
    <div className="h-[3px] rounded-sm bg-[rgba(196,160,80,0.15)] mt-1">
      <div
        className="h-full rounded-sm transition-all duration-500"
        style={{
          width: `${w}%`,
          background: "linear-gradient(90deg,#1e3a8a,#c4a050)",
        }}
      />
    </div>
  );
}

function SectionHeader({ children }) {
  return (
    <div className="flex items-center gap-2 mb-3 lg:mb-4">
      <span className="text-[0.72rem] lg:text-[0.82rem] tracking-[0.2em] uppercase text-[#c4a050] font-bold whitespace-nowrap">
        {children}
      </span>
      <span className="flex-1 h-px bg-[rgba(196,160,80,0.3)]" />
    </div>
  );
}

/*  FilterSlider  */

function FilterSlider({
  label,
  sub,
  min,
  max,
  value,
  onChange,
  onClear,
  fmtValue,
}) {
  const trackRef = useRef(null);
  const [minVal, maxVal] = value;
  const percent = (v) => ((v - min) / (max - min)) * 100;

  const handleMove = (clientX, thumb) => {
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const raw = min + ratio * (max - min);
    if (thumb === "min")
      onChange([Math.min(Math.max(raw, min), maxVal), maxVal]);
    else onChange([minVal, Math.max(Math.min(raw, max), minVal)]);
  };

  const startDrag = (thumb) => (e) => {
    e.preventDefault();
    let rafId = null;
    const move = (ev) => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        handleMove(ev.clientX, thumb);
        rafId = null;
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 lg:mb-2">
        <div>
          <div className="text-sm lg:text-[1rem] font-extrabold text-[#000000]">
            {label}
          </div>
          <div className="text-sm lg:text-[0.95rem] font-medium text-gray-500 mt-0.5">
            {sub}
          </div>
        </div>
        <span className="text-sm lg:text-[1rem] font-bold text-[#c4a050] bg-[rgba(196,160,80,0.1)] border border-[rgba(196,160,80,0.3)] px-2 lg:px-2.5 py-0.5 lg:py-1 rounded-sm">
          {fmtValue(minVal)} – {fmtValue(maxVal)}
        </span>
      </div>

      <div
        ref={trackRef}
        className="relative h-[3px] lg:h-[4px] rounded-full cursor-pointer"
        style={{
          background:
            "linear-gradient(90deg, #2f4a8a 0%, #6b7280 40%, #c4a050 100%)",
        }}
        onMouseDown={(e) => {
          const rect = trackRef.current.getBoundingClientRect();
          const clickVal =
            min + ((e.clientX - rect.left) / rect.width) * (max - min);
          handleMove(
            e.clientX,
            Math.abs(clickVal - minVal) < Math.abs(clickVal - maxVal)
              ? "min"
              : "max"
          );
        }}
      >
        {/* Min thumb */}
        <div
          onMouseDown={(e) => {
            e.stopPropagation();
            startDrag("min")(e);
          }}
          className="absolute cursor-pointer"
          style={{
            left: `${percent(minVal)}%`,
            top: "50%",
            transform: "translate(-50%, -50%)",
          }}
        >
          <div
            className="w-[15px] h-[15px] rounded-full"
            style={{ background: "#0d1f35", border: "2px solid #c4a050" }}
          />
        </div>
        {/* Max thumb */}
        <div
          onMouseDown={(e) => {
            e.stopPropagation();
            startDrag("max")(e);
          }}
          className="absolute cursor-pointer"
          style={{
            left: `${percent(maxVal)}%`,
            top: "50%",
            transform: "translate(-50%, -50%)",
          }}
        >
          <div
            className="w-[15px] h-[15px] rounded-full"
            style={{ background: "#0d1f35", border: "2px solid #c4a050" }}
          />
        </div>
      </div>

      <div className="flex justify-between text-[0.75rem] lg:text-[0.95rem] font-bold tracking-wide text-[rgb(0,0,0)] mt-2">
        <span>{fmtValue(min)}</span>
        <span>{fmtValue(max)}</span>
      </div>

      {(minVal > min || maxVal < max) && (
        <button
          onClick={onClear}
          className="mt-1.5 flex items-center gap-1 text-[0.67rem] lg:text-[0.74rem] font-semibold tracking-wide text-[#c4a050] bg-[rgba(196,160,80,0.1)] border border-[rgba(196,160,80,0.35)] px-2 py-0.5 rounded-sm hover:bg-[rgba(196,160,80,0.2)] transition-colors font-serif"
        >
          ✕ Filter active
        </button>
      )}
    </div>
  );
}

/*  InfraLegend  */

function InfraLegend({ poiLayers, onToggle, disabled = false }) {
  return (
    <div
      className="absolute top-3 right-3 z-[5] rounded-lg shadow-xl p-3 min-w-[200px] max-w-[min(100vw-24px,320px)] animate-fade-slide"
      style={{
        background: "rgba(10,26,47,0.92)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(196,160,80,0.18)",
        opacity: disabled ? 0.55 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
    >
      <div className="text-[0.7rem] tracking-[0.18em] uppercase text-[rgba(196,160,80,0.85)] mb-2.5 font-bold">
        Infrastructure
      </div>
      {Object.entries(POI_CONFIG).map(([key, cfg]) => {
        const on = poiLayers[key];
        const kind = cfg.kind ?? "cluster";
        return (
          <button
            key={key}
            onClick={() => onToggle(key)}
            className="flex items-center gap-2.5 w-full py-1.5 hover:bg-[rgba(240,236,227,0.06)] rounded px-1.5 transition-colors"
          >
            {kind === "line" ? (
              <span
                className="w-5 h-1 rounded-sm shrink-0 transition-all duration-200"
                style={{
                  background: "#6b7280",
                  opacity: on ? 1 : 0.25,
                  boxShadow: on ? "0 0 6px rgba(107,114,128,0.45)" : "none",
                }}
              />
            ) : kind === "fill" ? (
              <span
                className="w-3.5 h-3.5 rounded-sm shrink-0 border transition-all duration-200"
                style={{
                  background: cfg.fillColor,
                  borderColor: cfg.fillOutlineColor,
                  opacity: on ? 1 : 0.25,
                }}
              />
            ) : (
              <span
                className="w-2 h-2 rounded-full shrink-0 transition-all duration-200"
                style={{
                  background: cfg.color,
                  opacity: on ? 1 : 0.2,
                  boxShadow: on ? `0 0 6px ${cfg.color}60` : "none",
                }}
              />
            )}
            <span
              className={`text-sm font-semibold font-serif flex-1 text-left transition-colors ${
                on ? "text-[#f0ece3]" : "text-[rgba(240,236,227,0.35)]"
              }`}
            >
              {cfg.label}
            </span>
            <span
              className={`text-[0.68rem] font-bold tracking-wide ${
                on
                  ? "text-[rgba(196,160,80,0.8)]"
                  : "text-[rgba(240,236,227,0.22)]"
              }`}
            >
              {on ? "ON" : "OFF"}
            </span>
          </button>
        );
      })}
      {(poiLayers.ntd_reporters_2024 ||
        poiLayers.ntm_routes ||
        poiLayers.fta_admin_boundaries) && (
        <div className="mt-3 pt-3 border-t border-[rgba(196,160,80,0.22)] space-y-2.5 text-left max-h-[40vh] overflow-y-auto">
          {poiLayers.ntd_reporters_2024 ? (
            <div className="text-[0.65rem] leading-snug text-[rgba(240,236,227,0.62)]">
              <span className="text-[#c4a050] font-semibold">NTD 2024:</span>{" "}
              Each dot is a reporting agency. Clusters summarize density when
              zoomed out; zoom in to see individual agencies.
            </div>
          ) : null}
          {poiLayers.ntm_routes ? (
            <div>
              <div className="text-[0.62rem] uppercase tracking-[0.14em] text-[rgba(196,160,80,0.8)] mb-1.5 font-bold">
                Route colors (National Transit Map)
              </div>
              <div className="space-y-1">
                {NTM_ROUTE_LEGEND.map(({ label, color }) => (
                  <div
                    key={label}
                    className="flex items-center gap-2 text-[0.68rem] text-[rgba(240,236,227,0.82)]"
                  >
                    <span
                      className="w-7 h-1.5 rounded-sm shrink-0"
                      style={{ background: color }}
                    />
                    {label}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {poiLayers.fta_admin_boundaries ? (
            <div className="text-[0.65rem] leading-snug text-[rgba(240,236,227,0.62)]">
              <span className="text-[#c4a050] font-semibold">FTA UZA:</span>{" "}
              Urbanized areas (2020) sit under the county layer. Use{" "}
              <b className="text-[rgba(240,236,227,0.85)]">View layer → None</b>{" "}
              and zoom in to see fill and outlines most clearly.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/*  HoverCard  */

function HoverCard({ feature, position, visible }) {
  if (!visible || !feature || !position) return null;
  const p = feature.properties ?? {};
  const opp = p.score_opportunity ?? 0;
  const CARD_W = 200,
    CARD_H = 155,
    OFFSET = 16;
  const x = Math.min(position.x + OFFSET, window.innerWidth - CARD_W - 8);
  const y = Math.max(
    8,
    Math.min(position.y - CARD_H / 2, window.innerHeight - CARD_H - 8)
  );
  return (
    <div
      className="pointer-events-none fixed z-[500] animate-fade-slide"
      style={{ left: x, top: y }}
    >
      <div
        className="font-serif rounded-xl shadow-2xl"
        style={{
          width: CARD_W,
          background: "rgba(10,26,47,0.96)",
          backdropFilter: "blur(16px)",
          border: "1px solid rgba(196,160,80,0.22)",
        }}
      >
        <div
          className="px-4 pt-3.5 pb-2.5"
          style={{ borderBottom: "1px solid rgba(196,160,80,0.1)" }}
        >
          <div className="text-[1.05rem] font-bold text-[#f0ece3] leading-tight">
            {p.NAME ?? "—"}
          </div>
          <div className="text-[0.7rem] tracking-[0.14em] uppercase text-[rgba(240,236,227,0.6)] font-semibold mt-0.5">
            {p.STATE_ABBR ? `${p.STATE_ABBR} · ` : ""}United States
          </div>
        </div>
        <div className="px-4 py-2.5 space-y-1.5">
          {[
            ["Population", fmtNum(p.raw_population)],
            ["Median Income", fmtCurrency(p.raw_median_income)],
            ["Business Count", fmtNumFull(p.raw_business_count)],
            ["Agencies (county data)", fmtNumFull(p.raw_transit_agencies)],
          ].map(([label, val]) => (
            <div
              key={label}
              className="flex justify-between items-baseline gap-3"
            >
              <span className="text-xs font-medium text-[rgba(240,236,227,0.65)] shrink-0">
                {label}
              </span>
              <span className="text-sm font-semibold text-[#f0ece3] text-right">
                {val}
              </span>
            </div>
          ))}
        </div>
        <div
          className="px-4 pb-3.5 pt-2"
          style={{ borderTop: "1px solid rgba(196,160,80,0.1)" }}
        >
          <div className="flex items-center gap-2.5">
            <span className="text-2xl font-bold text-[#c4a050] font-serif leading-none tabular-nums">
              {Math.round(opp * 100)}
            </span>
            <div className="flex-1">
              <div className="text-[0.68rem] tracking-[0.14em] uppercase text-[rgba(240,236,227,0.55)] font-semibold mb-1">
                Opportunity Score
              </div>
              <div className="h-[2px] rounded-full bg-[rgba(196,160,80,0.12)]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${opp * 100}%`,
                    background: "linear-gradient(90deg,#1e3a8a,#c4a050)",
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/*  FilterPanelContent  */

function FilterPanelContent({
  dataBounds,
  filters,
  loading,
  activeFiltersCount,
  handleSliderChange,
  handleResetFilters,
  onClose,
  filterTransitAgenciesOnly,
  onTransitAgenciesToggle,
}) {
  return (
    <>
      <div className="flex items-start justify-between mb-5 lg:mb-6">
        <div>
          <div className="text-sm lg:text-base font-bold tracking-[0.1em] uppercase text-[#0d1f35]">
            Region Filters
          </div>
          <div className="text-xs lg:text-[0.82rem] font-medium text-gray-500 mt-1">
            Narrow qualifying regions
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-[rgba(13,31,53,0.35)] hover:text-[rgba(13,31,53,0.7)] transition-colors text-base cursor-pointer shrink-0 ml-2"
        >
          ✕
        </button>
      </div>

      {loading ? (
        <div className="text-xs opacity-50">Loading filters...</div>
      ) : (
        <>
          <SectionHeader>Demographics</SectionHeader>
          <div className="space-y-5 lg:space-y-6 mb-5 lg:mb-6">
            {FILTER_CONFIG.demographics.map((key) => {
              const meta = FILTER_META[key];
              return (
                <FilterSlider
                  key={key}
                  label={meta.label}
                  sub={meta.sub}
                  min={dataBounds[key].min}
                  max={dataBounds[key].max}
                  value={filters[key]}
                  fmtValue={meta.fmt}
                  onChange={(v) => handleSliderChange(key, v)}
                  onClear={() =>
                    handleSliderChange(key, [
                      dataBounds[key].min,
                      dataBounds[key].max,
                    ])
                  }
                />
              );
            })}
          </div>

          <div className="h-px bg-[rgba(13,31,53,0.08)] my-4" />

          <SectionHeader>Economic</SectionHeader>
          <div className="space-y-5 lg:space-y-6 mb-5 lg:mb-6">
            {FILTER_CONFIG.economic.map((key) => {
              const meta = FILTER_META[key];
              return (
                <FilterSlider
                  key={key}
                  label={meta.label}
                  sub={meta.sub}
                  min={dataBounds[key].min}
                  max={dataBounds[key].max}
                  value={filters[key]}
                  fmtValue={meta.fmt}
                  onChange={(v) => handleSliderChange(key, v)}
                  onClear={() =>
                    handleSliderChange(key, [
                      dataBounds[key].min,
                      dataBounds[key].max,
                    ])
                  }
                />
              );
            })}
          </div>

          <div className="h-px bg-[rgba(13,31,53,0.08)] my-4" />

          <SectionHeader>Mobility</SectionHeader>
          <label className="flex items-start gap-3 cursor-pointer group mb-2">
            <input
              type="checkbox"
              checked={filterTransitAgenciesOnly}
              onChange={(e) => onTransitAgenciesToggle(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border-[rgba(13,31,53,0.35)] text-[#0d1f35] cursor-pointer"
            />
            <div>
              <div className="text-sm lg:text-[0.95rem] font-semibold text-[#0d1f35] group-hover:text-[#0d1f35]">
                Transit Agencies
              </div>
              <div className="text-xs lg:text-[0.8rem] font-medium text-gray-500 mt-0.5 leading-snug">
                Show only counties with at least one reported transit agency
                (counts from NTD-style rollups).
              </div>
            </div>
          </label>
        </>
      )}

      <div className="h-px bg-[rgba(13,31,53,0.08)] my-4" />
      <div className="flex items-center gap-2 mb-3 lg:mb-4">
        <span className="text-[0.72rem] lg:text-[0.82rem] tracking-[0.2em] uppercase text-[#c4a050] font-bold whitespace-nowrap">
          Infrastructure
        </span>
        <span className="flex-1 h-px bg-[rgba(196,160,80,0.3)]" />
        <span className="text-[0.6rem] lg:text-[0.68rem] tracking-[0.1em] border border-[rgba(196,160,80,0.4)] text-[rgba(196,160,80,0.75)] px-1.5 py-0.5 rounded-sm">
          PHASE 2
        </span>
      </div>
      {["Infra. Score", "Workforce Density"].map((name) => (
        <div key={name} className="mb-4 lg:mb-5 opacity-40">
          <div className="text-sm lg:text-[0.95rem] font-semibold text-[#0d1f35] mb-0.5">
            {name}
          </div>
          <div className="text-xs lg:text-[0.8rem] font-medium text-gray-500 mb-2">
            {name === "Infra. Score"
              ? "Port, rail & logistics access"
              : "Labor availability index"}
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            defaultValue="1"
            disabled
          />
          <div className="flex justify-between text-[0.68rem] lg:text-[0.75rem] font-medium text-gray-400 mt-1">
            <span>Low</span>
            <span>High</span>
          </div>
        </div>
      ))}

      <div className="h-px bg-[rgba(13,31,53,0.08)] my-4 lg:my-5" />
      <div className="flex items-center justify-between py-2">
        <button
          onClick={handleResetFilters}
          className="flex items-center gap-1.5 text-xs lg:text-[0.82rem] tracking-[0.1em] uppercase text-gray-500 hover:text-gray-800 transition-colors font-semibold font-serif cursor-pointer"
        >
          ↺ Reset All
        </button>
        {activeFiltersCount > 0 && (
          <span className="text-xs lg:text-[0.82rem] font-semibold text-[#c4a050]">
            {activeFiltersCount} active
          </span>
        )}
      </div>
    </>
  );
}

/*  MobileFilterSheet  */

function MobileFilterSheet({ open, onClose, children }) {
  const dragRef = useRef({ startY: 0, dragging: false });
  const [dragY, setDragY] = useState(0);

  const onTouchStart = (e) => {
    dragRef.current = { startY: e.touches[0].clientY, dragging: true };
    setDragY(0);
  };
  const onTouchMove = (e) => {
    if (!dragRef.current.dragging) return;
    const dy = e.touches[0].clientY - dragRef.current.startY;
    if (dy > 0) setDragY(dy);
  };
  const onTouchEnd = () => {
    dragRef.current.dragging = false;
    if (dragY > 80) onClose();
    setDragY(0);
  };

  return (
    <div
      className="sm:hidden fixed inset-0 z-[200]"
      style={{ pointerEvents: open ? "auto" : "none" }}
    >
      <div
        className="absolute inset-0 bg-black/40 transition-opacity duration-300"
        style={{ opacity: open ? 1 : 0 }}
        onClick={onClose}
      />
      <div
        className="absolute bottom-0 left-0 right-0 bg-[#f5f1e8] rounded-t-2xl shadow-2xl flex flex-col transition-transform duration-300"
        style={{
          maxHeight: "82vh",
          transform: open ? `translateY(${dragY}px)` : "translateY(100%)",
        }}
      >
        <div
          className="flex justify-center pt-3 pb-1 shrink-0 cursor-grab touch-none"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <div className="w-10 h-1 bg-[rgba(13,31,53,0.2)] rounded-full" />
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-1">
          {children}
        </div>
      </div>
    </div>
  );
}

/*  RegionDetailPanel  */

function RegionDetailPanel({ p, onClose }) {
  return (
    <div className="flex flex-col h-full">
      <div className="bg-[#0d1f35] px-5 lg:px-7 py-5 lg:py-6 relative shrink-0">
        <div className="text-[0.7rem] lg:text-[0.78rem] tracking-[0.2em] uppercase text-[rgba(240,236,227,0.65)] font-semibold mb-1.5">
          Selected Region
        </div>
        <div className="text-2xl lg:text-3xl font-bold text-[#f0ece3] font-serif leading-tight">
          {p.NAME ?? "—"}
        </div>
        <div className="text-sm lg:text-base font-medium text-[rgba(240,236,227,0.65)] mt-1.5">
          United States · {p.STATE_ABBR ?? "County"}
        </div>
        <button
          onClick={onClose}
          className="absolute top-3 right-3 w-7 h-7 rounded-full bg-[rgba(240,236,227,0.1)] flex items-center justify-center text-[rgba(240,236,227,0.6)] hover:text-[#f0ece3] hover:bg-[rgba(240,236,227,0.18)] transition-colors text-sm cursor-pointer"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain p-5 lg:p-7">
        <div className="flex items-center gap-3 lg:gap-4 mb-5 lg:mb-6">
          <ScoreRing score01={p.score_opportunity ?? 0} />
          <div className="flex flex-col">
            <span className="text-[0.7rem] lg:text-[0.78rem] tracking-[0.16em] uppercase text-gray-500 font-semibold">
              Opportunity Score
            </span>
            <span className="text-2xl lg:text-3xl font-bold text-[#0d1f35] font-serif leading-none mt-0.5">
              {getScoreLabel(p.score_opportunity ?? 0)}
            </span>
            <span className="text-xs lg:text-[0.8rem] font-medium text-gray-500 mt-0.5">
              Population · Income · Business · Transit
            </span>
          </div>
        </div>

        <div className="h-px bg-[rgba(13,31,53,0.08)] mb-4 lg:mb-5" />
        <div className="text-[0.7rem] lg:text-[0.78rem] tracking-[0.2em] uppercase text-gray-500 font-semibold mb-3 lg:mb-4">
          Region Metrics
        </div>

        {[
          {
            icon: "👥",
            name: "Population",
            sub: "Total residents",
            val: fmtNumFull(p.raw_population),
            bar: p.score_population ?? 0,
            gold: false,
          },
          {
            icon: "💰",
            name: "Median Income",
            sub: "Annual household",
            val: fmtCurrency(p.raw_median_income),
            bar: p.score_income ?? 0,
            gold: false,
          },
          {
            icon: "🏢",
            name: "Business Count",
            sub: "Registered entities",
            val: fmtNumFull(p.raw_business_count),
            bar: p.score_business ?? 0,
            gold: false,
          },
          {
            icon: "🚌",
            name: "Transit supply (county)",
            sub:
              "From the county data row: agencies per 100k residents, normalized for scoring. USDOT map layers are separate (Infrastructure toggles).",
            val: fmtNumFull(p.raw_transit_agencies),
            bar: p.score_transit ?? 0,
            gold: false,
          },
          {
            icon: "⚡",
            name: "Opportunity Score",
            sub: "Normalized 0–100",
            val: Math.round((p.score_opportunity ?? 0) * 100),
            bar: p.score_opportunity ?? 0,
            gold: true,
          },
        ].map(({ icon, name, sub, val, bar, gold }) => (
          <div
            key={name}
            className="flex items-center gap-3 lg:gap-4 py-3 lg:py-4 border-b border-[rgba(13,31,53,0.07)] last:border-0"
          >
            <div className="w-9 h-9 lg:w-11 lg:h-11 rounded shrink-0 bg-[rgba(13,31,53,0.06)] flex items-center justify-center text-base lg:text-lg">
              {icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm lg:text-base font-semibold text-[#0d1f35]">
                {name}
              </div>
              <div className="text-xs lg:text-[0.8rem] font-medium text-gray-500">
                {sub}
              </div>
              <MiniBar value01={bar} />
            </div>
            <span
              className={`text-sm lg:text-base font-semibold shrink-0 ${
                gold ? "text-[#c4a050]" : "text-[#0d1f35]"
              }`}
            >
              {val}
            </span>
          </div>
        ))}

        <div className="mt-5 lg:mt-6 border border-[rgba(196,160,80,0.35)] border-l-[3px] border-l-[#c4a050] bg-[rgba(196,160,80,0.05)] rounded p-3.5 lg:p-5">
          <div className="flex items-center gap-1.5 mb-2 lg:mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-[#c4a050]" />
            <span className="text-[0.68rem] lg:text-[0.76rem] tracking-[0.16em] uppercase text-[#c4a050] font-semibold">
              Opportunity Signal
            </span>
          </div>
          <p className="text-sm lg:text-[0.9rem] font-medium text-gray-600 leading-relaxed">
            {(p.score_opportunity ?? 0) >= 0.75
              ? `${
                  p.NAME ?? "This region"
                } presents strong near-term supply chain opportunity based on composite metrics.`
              : (p.score_opportunity ?? 0) >= 0.5
              ? `${
                  p.NAME ?? "This region"
                } shows moderate supply chain potential. Monitor for infrastructure improvements.`
              : `${
                  p.NAME ?? "This region"
                } presents limited near-term supply chain opportunity. Reassess when infrastructure data becomes available.`}
          </p>
        </div>
      </div>
    </div>
  );
}

/*  Site password gate (API must set SITE_PASSWORD)  */

function SitePasswordGate({ apiBase, onSuccess }) {
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`${apiBase}/api/site-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwd }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setErr(typeof j.error === "string" ? j.error : "Incorrect password");
        setBusy(false);
        return;
      }
      if (!j.token) {
        setErr("Server did not return a session");
        setBusy(false);
        return;
      }
      setSessionToken(j.token);
      setPwd("");
      onSuccess();
    } catch {
      setErr("Could not reach the server");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-[#0d1f35] px-6 py-12 font-serif">
      <div className="w-full max-w-md rounded-xl border border-[rgba(196,160,80,0.35)] bg-[rgba(10,26,47,0.92)] p-8 shadow-2xl">
        <h1 className="text-xl font-bold tracking-[0.2em] text-[#f0ece3] text-center mb-1">
          <span className="text-[#c4a050]">SALT</span> ATLAS
        </h1>
        <p className="text-center text-sm text-[rgba(240,236,227,0.55)] mb-8 tracking-wide">
          Enter the access password to continue
        </p>
        <form onSubmit={submit} className="space-y-4">
          <input
            type="password"
            autoComplete="current-password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            placeholder="Password"
            className="w-full rounded-md border border-[rgba(196,160,80,0.35)] bg-[rgba(13,31,53,0.5)] px-4 py-3 text-[#f0ece3] placeholder:text-[rgba(240,236,227,0.35)] outline-none focus:border-[#c4a050]"
          />
          {err ? (
            <p className="text-sm text-red-300 text-center" role="alert">
              {err}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || !pwd.trim()}
            className="w-full py-3 rounded-md bg-[#c4a050] text-[#0d1f35] text-xs font-bold tracking-[0.15em] uppercase hover:bg-[#d4b060] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {busy ? "Checking…" : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* 
   Main App
 */

export default function App() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const mapboxglRef = useRef(null);

  // Data store: fips → { properties merged from backend }
  // Used for hover card, detail panel, top regions, CSV export.
  const dataMapRef = useRef({});

  // Sorted top-20 FIPS lists per score key
  const topByLayerRef = useRef({});

  // Filters state - kept in a ref so Mapbox filter expressions always see latest
  const filtersRef = useRef({});

  // Selection
  const selectionModeRef = useRef(false);
  const applySelectionRef = useRef(null);

  // Hover
  const setHoverFeatureRef = useRef(null);
  const setHoverPositionRef = useRef(null);

  // POI
  const poiLayersRef = useRef(
    Object.fromEntries(Object.keys(POI_CONFIG).map((k) => [k, false]))
  );
  /** Tracks which infrastructure layer keys have been fetched + added to the map */
  const poiKeysLoadedRef = useRef(new Set());
  const lastPoiSelectionRef = useRef(
    Object.fromEntries(Object.keys(POI_CONFIG).map((k) => [k, false]))
  );

  // Misc timers
  const updateMapTimeoutRef = useRef(null);
  const toastTimeoutRef = useRef(null);

  /*  Breakpoint  */
  const isDesktop = useIsDesktop();

  /*  React state  */
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState(null);
  const [activeLayer, setActiveLayer] = useState("none");
  const [selectedFeatures, setSelectedFeatures] = useState([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [mapOverlaysHidden, setMapOverlaysHidden] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [helpStep, setHelpStep] = useState(0);
  const [poiLayers, setPoiLayers] = useState(
    Object.fromEntries(Object.keys(POI_CONFIG).map((k) => [k, false]))
  );
  const [showInfraLegend, setShowInfraLegend] = useState(false);
  const [infraAllVisible, setInfraAllVisible] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(null);
  const [isUpdatingMap, setIsUpdatingMap] = useState(false);
  const [toast, setToast] = useState({ message: "", visible: false });
  const [hoverFeature, setHoverFeature] = useState(null);
  const [hoverPosition, setHoverPosition] = useState(null);

  const [dataBounds, setDataBounds] = useState({
    population: { min: 0, max: 1 },
    median_income: { min: 1000, max: 200000 },
    business_count: { min: 0, max: 1 },
  });
  const [filters, setFilters] = useState({
    population: [0, 1],
    median_income: [0, 1],
    business_count: [0, 1],
  });
  const [filterTransitAgenciesOnly, setFilterTransitAgenciesOnly] =
    useState(false);
  /** `checking` → ask API; `login` → show password form; `ready` → load map */
  const [siteAuthPhase, setSiteAuthPhase] = useState("checking");
  const [siteAuthRequired, setSiteAuthRequired] = useState(false);

  // Keep refs in sync
  setHoverFeatureRef.current = setHoverFeature;
  setHoverPositionRef.current = setHoverPosition;
  filtersRef.current = filters;

  useEffect(() => {
    selectionModeRef.current = selectionMode;
  }, [selectionMode]);
  useEffect(() => {
    poiLayersRef.current = poiLayers;
  }, [poiLayers]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const base = getApiBase();
        const r = await fetch(`${base}/api/auth-status`);
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        const required = Boolean(j.authRequired);
        setSiteAuthRequired(required);
        if (!required) {
          setSiteAuthPhase("ready");
          return;
        }
        if (getSessionToken()) {
          setSiteAuthPhase("ready");
          return;
        }
        setSiteAuthPhase("login");
        setLoading(false);
      } catch {
        if (!cancelled) setSiteAuthPhase("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      clearTimeout(updateMapTimeoutRef.current);
      clearTimeout(toastTimeoutRef.current);
    },
    []
  );

  // When switching to mobile, close panels that only exist on desktop.
  // This prevents their DOM nodes from leaving behind phantom flex width.
  useEffect(() => {
    if (!isDesktop) {
      setFiltersOpen(false);
      setSelectedRegion(null);
    }
  }, [isDesktop]);

  const hasSelection = selectedFeatures.length > 0;
  const activeFiltersCount =
    ["population", "median_income", "business_count"].filter(
      (k) =>
        filters[k][1] < dataBounds[k].max || filters[k][0] > dataBounds[k].min
    ).length + (filterTransitAgenciesOnly ? 1 : 0);

  /*  Toast  */

  const showToast = useCallback((msg, dur = 2200) => {
    clearTimeout(toastTimeoutRef.current);
    setToast({ message: msg, visible: true });
    toastTimeoutRef.current = setTimeout(
      () => setToast((t) => ({ ...t, visible: false })),
      dur
    );
  }, []);

  /*  Map init (single mount; `activeLayer` paint is updated in a separate effect)  */

  useEffect(() => {
    if (siteAuthPhase !== "ready") return;
    let cancelled = false;
    let map = null;

    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token?.trim()) {
      setBootstrapError(
        "Missing VITE_MAPBOX_TOKEN. Add your Mapbox public token to the environment and reload."
      );
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setBootstrapError(null);

    (async () => {
      try {
        const mapboxgl = (await import("mapbox-gl")).default;
        await import("mapbox-gl/dist/mapbox-gl.css");
        mapboxgl.accessToken = token;
        mapboxglRef.current = mapboxgl;

        if (cancelled || !mapContainer.current) return;

        map = new mapboxgl.Map({
          container: mapContainer.current,
          style:
            import.meta.env.VITE_MAPBOX_STYLE ?? "mapbox://styles/mapbox/light-v11",
          center: DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
          antialias: false,
        });
        map.setPitch(0);
        map.setBearing(0);
        map.setProjection("mercator");
        mapRef.current = map;

        map.on("error", (e) => {
          const msg = e?.error?.message || "Map could not load a tile or resource.";
          if (import.meta.env.DEV) console.warn("[mapbox]", e.error);
          showToast(`Map: ${msg}`, 4500);
        });

        map.on("load", async () => {
          if (cancelled) return;
          try {
            const API_BASE = getApiBase();
            const regionsUrl = `${API_BASE}/api/regions`;
            let regionsRes;
            try {
              regionsRes = await fetchRegionsWithRetry();
            } catch (fetchErr) {
              if (cancelled) return;
              const builtInApi = import.meta.env.VITE_API_URL;
              const hint = builtInApi
                ? `The app tried: ${regionsUrl}. Check that the API is up (Render dashboard), uses HTTPS, and allows browser requests (CORS is open on this API).`
                : `The app tried: ${regionsUrl}. This site has no VITE_API_URL, so it calls the same host as the map — Vercel does not serve /api. Rebuild with VITE_API_URL=https://your-api.onrender.com (your Render service URL, no trailing slash).`;
              setBootstrapError(
                `Could not reach the data API (${fetchErr?.message || "network error"}). ${hint}`
              );
              showToast("Failed to load regions from API", 5000);
              setLoading(false);
              return;
            }
            if (cancelled) return;

            if (!regionsRes.ok) {
              const errTxt = await regionsRes.text();
              let errJson = null;
              try {
                errJson = JSON.parse(errTxt);
              } catch {
                /* plain text body */
              }
              if (
                regionsRes.status === 401 &&
                errJson?.code === "SITE_AUTH_REQUIRED"
              ) {
                clearSessionToken();
                setSiteAuthPhase("login");
                setLoading(false);
                return;
              }
              setBootstrapError(
                `Could not load region data (${regionsRes.status}). Check VITE_API_URL and that the API is running.`
              );
              if (import.meta.env.DEV) console.error("[regions]", errTxt);
              showToast("Failed to load regions from API", 5000);
              setLoading(false);
              return;
            }

            const ct = regionsRes.headers.get("content-type") || "";
            if (!ct.includes("application/json")) {
              setBootstrapError(
                `Expected JSON from the API but got "${ct.slice(0, 40)}…" from ${regionsUrl}. Usually this means VITE_API_URL is unset and /api is hitting the static host (Vercel) instead of Render. Set VITE_API_URL to your backend origin and redeploy.`
              );
              showToast("Invalid response from API URL", 5000);
              setLoading(false);
              return;
            }

            const backendData = await regionsRes.json();
            if (!Array.isArray(backendData)) {
              setBootstrapError("Region data was not in the expected format.");
              showToast("Invalid region data from API", 5000);
              setLoading(false);
              return;
            }

        /* Build data map and compute bounds */
        const dataMap = {};
        const boundsAcc = {
          population: { min: Infinity, max: -Infinity },
          median_income: { min: Infinity, max: -Infinity },
          business_count: { min: Infinity, max: -Infinity },
        };

        backendData.forEach((row) => {
          if (!row?.id) return;
          const fips = String(row.id).padStart(5, "0");
          const r = row.raw_data ?? {};
          const s = row.scores ?? {};
          const pop = Number(r.population),
            inc = Number(r.median_income),
            bus = Number(r.business_count);
          dataMap[fips] = {
            fips,
            // Raw values for hover/detail panel (properties namespace)
            raw_population: isFinite(pop) ? pop : 0,
            raw_median_income: isFinite(inc) ? inc : 0,
            raw_business_count: isFinite(bus) ? bus : 0,
            raw_transit_agencies: Number(r.transit_agencies) || 0,
            score_opportunity: Number(s.opportunity_score) || 0,
            score_population: Number(s.population_norm) || 0,
            score_income: Number(s.median_income_norm) || 0,
            score_business: Number(s.business_count_norm) || 0,
            score_transit: Number(s.transit_density_norm) || 0,
          };
          if (isFinite(pop) && pop >= 0) {
            boundsAcc.population.min = Math.min(boundsAcc.population.min, pop);
            boundsAcc.population.max = Math.max(boundsAcc.population.max, pop);
          }
          if (isFinite(inc) && inc > 0) {
            boundsAcc.median_income.min = Math.min(
              boundsAcc.median_income.min,
              inc
            );
            boundsAcc.median_income.max = Math.max(
              boundsAcc.median_income.max,
              inc
            );
          }
          if (isFinite(bus) && bus >= 0) {
            boundsAcc.business_count.min = Math.min(
              boundsAcc.business_count.min,
              bus
            );
            boundsAcc.business_count.max = Math.max(
              boundsAcc.business_count.max,
              bus
            );
          }
        });

        if (!isFinite(boundsAcc.population.min))
          boundsAcc.population = { min: 0, max: 1 };
        if (!isFinite(boundsAcc.median_income.min))
          boundsAcc.median_income = { min: 1000, max: 200000 };
        if (!isFinite(boundsAcc.business_count.min))
          boundsAcc.business_count = { min: 0, max: 1 };

        dataMapRef.current = dataMap;

        // Pre-compute top-20 lists per score key
        const allFips = Object.keys(dataMap);
        const sortedBy = (key) =>
          allFips
            .slice()
            .sort((a, b) => (dataMap[b][key] ?? 0) - (dataMap[a][key] ?? 0))
            .slice(0, 20);
        topByLayerRef.current = {
          score_opportunity: sortedBy("score_opportunity"),
          score_population: sortedBy("score_population"),
          score_income: sortedBy("score_income"),
          score_business: sortedBy("score_business"),
          score_transit: sortedBy("score_transit"),
        };

        setDataBounds(boundsAcc);
        setFilters({
          population: [boundsAcc.population.min, boundsAcc.population.max],
          median_income: [
            boundsAcc.median_income.min,
            boundsAcc.median_income.max,
          ],
          business_count: [
            boundsAcc.business_count.min,
            boundsAcc.business_count.max,
          ],
        });
        filtersRef.current = {
          population: [boundsAcc.population.min, boundsAcc.population.max],
          median_income: [
            boundsAcc.median_income.min,
            boundsAcc.median_income.max,
          ],
          business_count: [
            boundsAcc.business_count.min,
            boundsAcc.business_count.max,
          ],
        };

        /*  Add vector tile source + layers  */
        map.addSource("counties", {
          type: "vector",
          url: TILESET_URL,
          promoteId: "GEOID", // tells Mapbox to use GEOID as the numeric feature ID for feature-state
        });

        map.addLayer({
          id: "counties-fill",
          type: "fill",
          source: "counties",
          "source-layer": SOURCE_LAYER,
          paint: {
            "fill-color": buildFillColor(activeLayer),
            "fill-opacity": 0.07,
          },
        });

        map.addLayer({
          id: "counties-outline",
          type: "line",
          source: "counties",
          "source-layer": SOURCE_LAYER,
          paint: {
            "line-color": "rgba(148,163,184,0.45)",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              3,
              0.08,
              6,
              0.18,
              9,
              0.32,
            ],
          },
        });

        /* Inject feature-state for every county that has backend data */
        Object.entries(dataMap).forEach(([fips, d]) => {
          map.setFeatureState(
            { source: "counties", sourceLayer: SOURCE_LAYER, id: fips },
            {
              hasData: true,
              raw_population: d.raw_population,
              raw_median_income: d.raw_median_income,
              raw_business_count: d.raw_business_count,
              raw_transit_agencies: d.raw_transit_agencies,
              fs_score_opportunity: d.score_opportunity,
              fs_score_population: d.score_population,
              fs_score_income: d.score_income,
              fs_score_business: d.score_business,
              fs_score_transit: d.score_transit,
            }
          );
        });

        /* Hover */
        let hoveredId = null;
        map.on("mousemove", "counties-fill", (e) => {
          if (!e.features?.length) return;
          const feat = e.features[0];
          const id = String(feat.id ?? feat.properties?.GEOID ?? "").padStart(
            5,
            "0"
          );
          if (!id || id === "00000") return;

          if (hoveredId !== null && hoveredId !== id) {
            map.setFeatureState(
              { source: "counties", sourceLayer: SOURCE_LAYER, id: hoveredId },
              { hover: false }
            );
          }
          hoveredId = id;
          map.setFeatureState(
            { source: "counties", sourceLayer: SOURCE_LAYER, id },
            { hover: true }
          );

          // Enrich hover feature with our backend data for the HoverCard
          const d = dataMapRef.current[id] ?? {};
          const enrichedProps = {
            ...feat.properties,
            raw_population: d.raw_population ?? 0,
            raw_median_income: d.raw_median_income ?? 0,
            raw_business_count: d.raw_business_count ?? 0,
            raw_transit_agencies: d.raw_transit_agencies ?? 0,
            score_opportunity: d.score_opportunity ?? 0,
            score_population: d.score_population ?? 0,
            score_income: d.score_income ?? 0,
            score_business: d.score_business ?? 0,
            score_transit: d.score_transit ?? 0,
          };
          setHoverFeatureRef.current?.({
            ...feat,
            id,
            properties: enrichedProps,
          });
          setHoverPositionRef.current?.({
            x: e.originalEvent.clientX,
            y: e.originalEvent.clientY,
          });
        });

        map.on("mouseleave", "counties-fill", () => {
          if (hoveredId !== null) {
            map.setFeatureState(
              { source: "counties", sourceLayer: SOURCE_LAYER, id: hoveredId },
              { hover: false }
            );
          }
          hoveredId = null;
          setHoverFeatureRef.current?.(null);
          setHoverPositionRef.current?.(null);
        });

        /* Click */
        map.on("click", "counties-fill", (e) => {
          if (!e.features?.length) return;

          // If a POI point is on top, let that handler fire instead
          const poiLayerIds = Object.keys(POI_CONFIG).flatMap((k) => {
            const cfg = POI_CONFIG[k];
            const kind = cfg.kind ?? "cluster";
            if (kind === "line")
              return map.getLayer(`${k}-line`) ? [`${k}-line`] : [];
            if (kind === "fill") return [];
            return [`${k}-points`, `${k}-clusters`].filter((lid) =>
              map.getLayer(lid)
            );
          });
          if (
            poiLayerIds.length &&
            map.queryRenderedFeatures(e.point, { layers: poiLayerIds }).length >
              0
          )
            return;

          const feat = e.features[0];
          const id = String(feat.id ?? feat.properties?.GEOID ?? "").padStart(
            5,
            "0"
          );
          if (!id || id === "00000") return;

          const d = dataMapRef.current[id] ?? {};
          const enrichedProps = {
            ...feat.properties,
            raw_population: d.raw_population ?? 0,
            raw_median_income: d.raw_median_income ?? 0,
            raw_business_count: d.raw_business_count ?? 0,
            raw_transit_agencies: d.raw_transit_agencies ?? 0,
            score_opportunity: d.score_opportunity ?? 0,
            score_population: d.score_population ?? 0,
            score_income: d.score_income ?? 0,
            score_business: d.score_business ?? 0,
            score_transit: d.score_transit ?? 0,
          };
          const enrichedFeature = { ...feat, id, properties: enrichedProps };

          // On mobile, suppress info panel while in selection mode
          const isMobile = window.innerWidth < 640;
          if (!isMobile || !selectionModeRef.current) {
            setSelectedRegion(enrichedFeature);
          }

          // Only modify selection when Select Mode is ON
          if (selectionModeRef.current) {
            applySelectionRef.current?.("toggle", enrichedFeature);
          }
        });

            if (!cancelled) setLoading(false);
          } catch (err) {
            if (import.meta.env.DEV) console.error("MAP LOAD ERROR:", err);
            if (!cancelled) {
              setBootstrapError(
                err?.message
                  ? `Map setup failed: ${err.message}`
                  : "Map setup failed. Try refreshing the page."
              );
              showToast("Could not finish loading the map", 5000);
              setLoading(false);
            }
          }
        });
      } catch (err) {
        if (import.meta.env.DEV) console.error("MAPBOX INIT ERROR:", err);
        if (!cancelled) {
          setBootstrapError(
            err?.message
              ? `Could not initialize map: ${err.message}`
              : "Could not initialize map libraries."
          );
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      mapboxglRef.current = null;
    };
    // `activeLayer` is applied after load via the choropleth effect — do not remount the map when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showToast, siteAuthPhase]);

  /* Reactive: choropleth layer color  */
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("counties-fill")) return;

    if (activeLayer === "none") {
      map.setPaintProperty("counties-fill", "fill-color", [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        "#c4a050", // gold for selected
        ["boolean", ["feature-state", "hover"], false],
        "#facc15", // hover
        "rgba(0,0,0,0)", // invisible otherwise
      ]);
    } else {
      map.setPaintProperty(
        "counties-fill",
        "fill-color",
        buildFillColor(activeLayer)
      );
    }
  }, [activeLayer]);

  /*  Reactive: filter opacity  */
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("counties-fill")) return;

    // Build a Mapbox expression that compares feature-state values against filter bounds.
    // We use feature-state because that's where our raw data lives in the vector tile approach.
    const conditions = Object.entries(FILTER_META).map(([key, meta]) => {
      const [lo, hi] = filters[key];
      return [
        "all",
        [">=", ["coalesce", ["feature-state", meta.prop], 0], lo],
        ["<=", ["coalesce", ["feature-state", meta.prop], 0], hi],
      ];
    });

    const allFilterParts = filterTransitAgenciesOnly
      ? [
          ...conditions,
          [">=", ["coalesce", ["feature-state", "raw_transit_agencies"], 0], 1],
        ]
      : conditions;

    map.setPaintProperty(
      "counties-fill",
      "fill-opacity",
      activeLayer === "none"
        ? [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            1,
            ["boolean", ["feature-state", "hover"], false],
            1,
            0.07,
          ]
        : [
            "case",
            ["!", ["boolean", ["feature-state", "hasData"], false]],
            0.07,
            ["all", ...allFilterParts],
            0.85,
            0.07,
          ]
    );
  }, [filters, activeLayer, filterTransitAgenciesOnly]);

  /*  Reactive: POI layer visibility  */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    Object.entries(poiLayers).forEach(([key, visible]) => {
      const cfg = POI_CONFIG[key];
      const kind = cfg?.kind ?? "cluster";
      const vis = visible ? "visible" : "none";
      if (kind === "line") {
        if (map.getLayer(`${key}-line`))
          map.setLayoutProperty(`${key}-line`, "visibility", vis);
        return;
      }
      if (kind === "fill") {
        if (map.getLayer(`${key}-fill`))
          map.setLayoutProperty(`${key}-fill`, "visibility", vis);
        return;
      }
      ["clusters", "cluster-count", "points"].forEach((type) => {
        const lid = `${key}-${type}`;
        if (!map.getLayer(lid)) return;
        map.setLayoutProperty(lid, "visibility", vis);
      });
    });
  }, [poiLayers]);

  /*  Help keyboard nav  */
  useEffect(() => {
    const handler = (e) => {
      if (!showHelp) return;
      if (e.key === "ArrowRight")
        setHelpStep((p) => Math.min(p + 1, HELP_STEPS.length - 1));
      if (e.key === "ArrowLeft") setHelpStep((p) => Math.max(p - 1, 0));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showHelp]);

  /*  Unified selection system  */
  const applySelection = useCallback((mode, payload) => {
    const map = mapRef.current;
    if (!map) return;

    setSelectedFeatures((prev) => {
      // Clear all existing selections in Mapbox
      prev.forEach((f) =>
        map.setFeatureState(
          {
            source: "counties",
            sourceLayer: SOURCE_LAYER,
            id: String(f.id).padStart(5, "0"),
          },
          { selected: false }
        )
      );

      if (mode === "clear") return [];

      if (mode === "set") {
        const next = payload ?? [];
        next.forEach((f) =>
          map.setFeatureState(
            {
              source: "counties",
              sourceLayer: SOURCE_LAYER,
              id: String(f.id).padStart(5, "0"),
            },
            { selected: true }
          )
        );
        return next;
      }

      if (mode === "toggle") {
        const feature = payload;
        const id = String(feature.id).padStart(5, "0");
        const alreadySelected = prev.some(
          (f) => String(f.id).padStart(5, "0") === id
        );

        if (alreadySelected) {
          // Re-apply selected state to all others (top pass cleared everyone)
          prev.forEach((f) => {
            if (String(f.id).padStart(5, "0") !== id) {
              map.setFeatureState(
                {
                  source: "counties",
                  sourceLayer: SOURCE_LAYER,
                  id: String(f.id).padStart(5, "0"),
                },
                { selected: true }
              );
            }
          });
          return prev.filter((f) => String(f.id).padStart(5, "0") !== id);
        } else {
          // Re-apply existing + add new
          prev.forEach((f) =>
            map.setFeatureState(
              {
                source: "counties",
                sourceLayer: SOURCE_LAYER,
                id: String(f.id).padStart(5, "0"),
              },
              { selected: true }
            )
          );
          map.setFeatureState(
            { source: "counties", sourceLayer: SOURCE_LAYER, id },
            { selected: true }
          );
          return [...prev, feature];
        }
      }

      return prev;
    });
  }, []);

  applySelectionRef.current = applySelection;

  const clearSelections = useCallback(
    () => applySelection("clear"),
    [applySelection]
  );

  /*  Filter handlers  */

  const handleSliderChange = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setIsUpdatingMap(true);
    clearTimeout(updateMapTimeoutRef.current);
    updateMapTimeoutRef.current = setTimeout(
      () => setIsUpdatingMap(false),
      750
    );
  };

  const resetFiltersToMax = useCallback(() => {
    setFilters({
      population: [dataBounds.population.min, dataBounds.population.max],
      median_income: [
        dataBounds.median_income.min,
        dataBounds.median_income.max,
      ],
      business_count: [
        dataBounds.business_count.min,
        dataBounds.business_count.max,
      ],
    });
    setFilterTransitAgenciesOnly(false);
  }, [dataBounds]);

  const handleTransitAgenciesToggle = useCallback((checked) => {
    setFilterTransitAgenciesOnly(checked);
    setIsUpdatingMap(true);
    clearTimeout(updateMapTimeoutRef.current);
    updateMapTimeoutRef.current = setTimeout(
      () => setIsUpdatingMap(false),
      750
    );
  }, []);

  /*  Layer handler  */

  const handleLayerChange = (layer) => {
    setActiveLayer(layer);
    showToast(`Layer: ${layerLabel[layer]}`, 1600);
  };

  /*  POI  */

  /** Load only the requested infrastructure keys (lazy — avoids waiting on every layer). */
  const loadPoiInfrastructure = useCallback(
    async (requestedKeys) => {
      const map = mapRef.current;
      if (!map) return;

      const keysToLoad = [...new Set(requestedKeys)].filter(
        (k) => POI_CONFIG[k] && !poiKeysLoadedRef.current.has(k)
      );
      if (!keysToLoad.length) return;

      if (!map.loaded())
        await new Promise((resolve) => map.once("load", resolve));

      const slow = keysToLoad.some((k) =>
        ["ntd_reporters_2024", "ntm_routes", "fta_admin_boundaries"].includes(k)
      );
      if (slow) {
        showToast(
          "Loading selected USDOT layers (first server fetch can take 30–90s; later toggles use cache)…",
          7000
        );
      }

      const results = await Promise.allSettled(
        keysToLoad.map((key) => {
          const cfg = POI_CONFIG[key];
          return apiFetch(cfg.endpoint).then(async (r) => {
            if (!r.ok) throw new Error(`${r.status}`);
            const data = await r.json();
            return { key, config: cfg, data };
          });
        })
      );

      const failedPoi = [];
      results.forEach((res, idx) => {
        const key = keysToLoad[idx];
        if (res.status === "rejected") {
          failedPoi.push(key);
          return;
        }
        const { config, data } = res.value;
        const vis = poiLayersRef.current[key] ? "visible" : "none";
        const kind = config.kind ?? "cluster";

        if (kind === "fill") {
          const beforeId = map.getLayer("counties-fill")
            ? "counties-fill"
            : undefined;
          if (!map.getSource(key)) {
            map.addSource(key, { type: "geojson", data });
          }
          if (!map.getLayer(`${key}-fill`)) {
            const fillLayer = {
              id: `${key}-fill`,
              type: "fill",
              source: key,
              layout: { visibility: vis },
              paint: {
                "fill-color": config.fillColor ?? "#c4a050",
                "fill-opacity": config.fillOpacity ?? 0.26,
                "fill-outline-color":
                  config.fillOutlineColor ?? "rgba(92,72,16,0.95)",
              },
            };
            if (beforeId) map.addLayer(fillLayer, beforeId);
            else map.addLayer(fillLayer);
          }
          poiKeysLoadedRef.current.add(key);
          return;
        }

        if (kind === "line") {
          if (!map.getSource(key)) {
            map.addSource(key, { type: "geojson", data });
          }
          if (!map.getLayer(`${key}-line`)) {
            map.addLayer({
              id: `${key}-line`,
              type: "line",
              source: key,
              layout: {
                visibility: vis,
                "line-cap": "round",
                "line-join": "round",
              },
              paint: {
                "line-color": NTM_ROUTE_LINE_COLOR,
                "line-width": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  4,
                  1.2,
                  8,
                  2.5,
                  12,
                  4,
                ],
                "line-opacity": 0.9,
              },
            });
            map.on("mouseenter", `${key}-line`, () => {
              map.getCanvas().style.cursor = "pointer";
            });
            map.on("mouseleave", `${key}-line`, () => {
              map.getCanvas().style.cursor = "";
            });
            map.on("click", `${key}-line`, (e) => {
              e.preventDefault();
              const f = e.features?.[0];
              if (!f) return;
              const Mbx = mapboxglRef.current;
              if (!Mbx) return;
              const name =
                f.properties?.route_short_name ||
                f.properties?.route_long_name ||
                f.properties?.route_desc ||
                "Route";
              const sub = [
                f.properties?.route_type_text,
                f.properties?.route_desc,
              ]
                .filter(Boolean)
                .slice(0, 2)
                .join(" · ");
              new Mbx.Popup({ closeButton: true, maxWidth: "260px" })
                .setLngLat(e.lngLat)
                .setHTML(
                  `<div style="font-size:13px;font-family:'Cormorant Garamond',Georgia,serif;padding:2px 0;">
                <strong style="color:#c4a050;font-size:14px;">${poiPopupEsc(
                  name
                )}</strong>
                <div style="font-size:11px;opacity:0.75;margin-top:4px;">${poiPopupEsc(
                  sub || config.label
                )}</div>
              </div>`
                )
                .addTo(map);
            });
          }
          try {
            map.moveLayer(`${key}-line`);
          } catch {
            /* ignore */
          }
          poiKeysLoadedRef.current.add(key);
          return;
        }

        const isNtd = key === "ntd_reporters_2024";

        if (!map.getSource(key)) {
          map.addSource(key, {
            type: "geojson",
            data,
            cluster: config.cluster,
            clusterMaxZoom: 8,
            clusterRadius: 20,
          });
        }

        if (config.cluster && !map.getLayer(`${key}-clusters`)) {
          map.addLayer({
            id: `${key}-clusters`,
            type: "circle",
            source: key,
            filter: ["has", "point_count"],
            layout: { visibility: vis },
            paint: {
              "circle-color": config.color,
              "circle-radius": [
                "step",
                ["get", "point_count"],
                10,
                50,
                16,
                100,
                22,
              ],
              ...(isNtd
                ? {
                    "circle-opacity": [
                      "interpolate",
                      ["linear"],
                      ["get", "point_count"],
                      1,
                      0.3,
                      30,
                      0.72,
                      120,
                      1,
                    ],
                  }
                : { "circle-opacity": 0.92 }),
            },
          });
        }

        if (config.cluster && !map.getLayer(`${key}-cluster-count`)) {
          map.addLayer({
            id: `${key}-cluster-count`,
            type: "symbol",
            source: key,
            filter: ["has", "point_count"],
            layout: {
              visibility: vis,
              "text-field": ["get", "point_count_abbreviated"],
              "text-size": 10,
            },
          });
        }

        if (!map.getLayer(`${key}-points`)) {
          map.addLayer({
            id: `${key}-points`,
            type: "circle",
            source: key,
            filter: config.cluster ? ["!", ["has", "point_count"]] : ["all"],
            layout: { visibility: vis },
            paint: isNtd
              ? {
                  "circle-radius": [
                    "interpolate",
                    ["linear"],
                    ["coalesce", ["get", "weight"], 0.35],
                    0.25,
                    6,
                    1,
                    14,
                  ],
                  "circle-color": "#450a0a",
                  "circle-opacity": [
                    "interpolate",
                    ["linear"],
                    ["coalesce", ["get", "weight"], 0.35],
                    0.55,
                    0.45,
                    1,
                    1,
                  ],
                  "circle-stroke-width": 1.5,
                  "circle-stroke-color": "#ffffff",
                }
              : {
                  "circle-radius": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    3,
                    4,
                    8,
                    8,
                    12,
                    12,
                  ],
                  "circle-color": config.color,
                  "circle-opacity": 0.9,
                },
          });

          map.on("mouseenter", `${key}-points`, () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", `${key}-points`, () => {
            map.getCanvas().style.cursor = "";
          });

          map.on("click", `${key}-clusters`, (e) => {
            const feats = map.queryRenderedFeatures(e.point, {
              layers: [`${key}-clusters`],
            });
            if (!feats?.length) return;
            map
              .getSource(key)
              .getClusterExpansionZoom(
                feats[0].properties.cluster_id,
                (err, zoom) => {
                  if (!err)
                    map.easeTo({
                      center: feats[0].geometry.coordinates,
                      zoom,
                      duration: 500,
                    });
                }
              );
          });

          map.on("click", `${key}-points`, (e) => {
            e.preventDefault();
            const f = e.features[0];
            const Mbx = mapboxglRef.current;
            if (!Mbx) return;
            const title =
              key === "ntd_reporters_2024"
                ? f.properties.AGENCY_NM || f.properties.name
                : f.properties.name || config.label;
            const sub =
              key === "ntd_reporters_2024"
                ? [f.properties.RPT_TYPE, f.properties.UZA_NM]
                    .filter(Boolean)
                    .join(" · ") || config.label
                : config.label;
            new Mbx.Popup({ closeButton: true, maxWidth: "260px" })
              .setLngLat(e.lngLat)
              .setHTML(
                `<div style="font-size:13px;font-family:'Cormorant Garamond',Georgia,serif;padding:2px 0;">
                <strong style="color:#c4a050;font-size:14px;">${poiPopupEsc(
                  title
                )}</strong>
                <div style="font-size:11px;opacity:0.55;margin-top:3px;">${poiPopupEsc(
                  sub
                )}</div>
              </div>`
              )
              .addTo(map);
          });
        }

        ["clusters", "cluster-count", "points"].forEach((suffix) => {
          const lid = `${key}-${suffix}`;
          if (map.getLayer(lid)) {
            try {
              map.moveLayer(lid);
            } catch {
              /* ignore if style API differs */
            }
          }
        });
        poiKeysLoadedRef.current.add(key);
      });

      if (failedPoi.length) {
        const labels = failedPoi
          .map((k) => POI_CONFIG[k]?.label ?? k)
          .join(", ");
        showToast(`Could not load: ${labels}`, 5000);
      }
    },
    [showToast]
  );

  const handlePoiToggle = (key) => {
    setPoiLayers((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      poiLayersRef.current = next;
      if (next[key]) void loadPoiInfrastructure([key]);
      return next;
    });
  };

  const handleInfraToggleAll = () => {
    if (mapOverlaysHidden) {
      showToast(
        `Turn off overlay hidden mode "👁" to handle infrastructure`,
        2000
      );
      return;
    }

    const next = !infraAllVisible;
    setInfraAllVisible(next);
    setShowInfraLegend(next);
    if (!next) {
      lastPoiSelectionRef.current = poiLayersRef.current;
      const allOff = Object.fromEntries(
        Object.keys(POI_CONFIG).map((k) => [k, false])
      );
      poiLayersRef.current = allOff;
      setPoiLayers(allOff);
    } else {
      const restored = lastPoiSelectionRef.current ?? {};
      const nextLayers = Object.fromEntries(
        Object.keys(POI_CONFIG).map((k) => [k, !!restored[k]])
      );
      poiLayersRef.current = nextLayers;
      setPoiLayers(nextLayers);
      void loadPoiInfrastructure(
        Object.keys(POI_CONFIG).filter((k) => nextLayers[k])
      );
    }
    showToast(next ? "Infrastructure shown" : "Infrastructure hidden", 1600);
  };

  /*  Top regions  */

  const handleTopRegions = () => {
    if (!selectionMode) {
      setSelectionMode(true);
      selectionModeRef.current = true;
    }

    const scoreKey = [
      "score_opportunity",
      "score_population",
      "score_income",
      "score_business",
      "score_transit",
    ].includes(activeLayer)
      ? activeLayer
      : "score_opportunity";

    const currentFilters = filtersRef.current;
    const dataMap = dataMapRef.current;

    // Filter by current slider bounds, then sort by score, take top 20
    const top = Object.entries(dataMap)
      .filter(([, d]) => {
        if (filterTransitAgenciesOnly && (d.raw_transit_agencies ?? 0) < 1)
          return false;
        return Object.entries(FILTER_META).every(([key, meta]) => {
          const val = d[meta.prop] ?? 0;
          const [lo, hi] = currentFilters[key] ?? [0, Infinity];
          return val >= lo && val <= hi;
        });
      })
      .sort(([, a], [, b]) => (b[scoreKey] ?? 0) - (a[scoreKey] ?? 0))
      .slice(0, 20)
      .map(([fips, d]) => ({
        id: fips,
        properties: { ...d, NAME: dataMapRef.current[fips]?.NAME ?? fips },
      }));

    // Enrich with NAME from the actual feature state if available
    // We'll pull it from the raw backendData. At this point properties may not have NAME.
    // NAME comes from the vector tile feature properties needed to query the map.
    const map = mapRef.current;
    const topWithNames = top.map((f) => {
      // Try to get the name from a rendered feature
      const rendered = map
        ? map.querySourceFeatures("counties", {
            sourceLayer: SOURCE_LAYER,
            filter: ["==", "GEOID", f.id],
          })
        : [];
      const name = rendered[0]?.properties?.NAME ?? f.id;
      const stateAbbr = rendered[0]?.properties?.STATE_ABBR ?? "";
      return {
        ...f,
        properties: { ...f.properties, NAME: name, STATE_ABBR: stateAbbr },
      };
    });

    applySelection("set", topWithNames);
    showToast(`Top ${topWithNames.length} regions selected`, 2200);
  };

  /*  Full reset  */

  const handleFullReset = () => {
    resetFiltersToMax();
    applySelection("clear");
    setSelectionMode(false);
    selectionModeRef.current = false;
    setSelectedRegion(null);
    mapRef.current?.flyTo({
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      duration: 900,
    });
    showToast("Reset complete", 1400);
  };

  const handleRecenter = () => {
    mapRef.current?.flyTo({
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      duration: 900,
    });
  };

  /*  CSV export  */

  const handleExportCSV = () => {
    if (!hasSelection) {
      showToast("Select at least one region to export", 2000);
      return;
    }
    // Turn off selection mode on export and keep selections but exit select UX
    setSelectionMode(false);
    selectionModeRef.current = false;
    showToast("Preparing CSV export…", 1800);
    setTimeout(async () => {
      try {
        const { default: Papa } = await import("papaparse");
        const rows = selectedFeatures.map((f) => ({
          region: f.properties.NAME,
          population: f.properties.raw_population,
          median_income: f.properties.raw_median_income,
          business_count: f.properties.raw_business_count,
          transit_agencies: f.properties.raw_transit_agencies,
          population_norm: f.properties.score_population,
          income_norm: f.properties.score_income,
          business_norm: f.properties.score_business,
          opportunity_score: f.properties.score_opportunity,
          "Transit Score": f.properties.score_transit,
        }));
        const blob = new Blob([Papa.unparse(rows)], {
          type: "text/csv;charset=utf-8;",
        });
        const link = Object.assign(document.createElement("a"), {
          href: URL.createObjectURL(blob),
          download: "salt_atlas_export.csv",
        });
        link.click();
        // Data is captured, now clean up visual state
        clearSelections();
        setSelectedRegion(null);
        showToast("Export ready ✓", 2000);
      } catch {
        showToast("Export failed", 2200);
      }
    }, 900);
  };

  /*  Render  */

  if (siteAuthPhase === "checking") {
    return (
      <div className="flex flex-col h-full w-full items-center justify-center bg-[#0d1f35] text-[#f0ece3] font-serif">
        <p className="text-sm tracking-[0.25em] uppercase text-[rgba(240,236,227,0.65)]">
          Checking access…
        </p>
      </div>
    );
  }

  if (siteAuthPhase === "login") {
    return (
      <SitePasswordGate
        apiBase={getApiBase()}
        onSuccess={() => {
          setLoading(true);
          setSiteAuthPhase("ready");
        }}
      />
    );
  }

  const p = selectedRegion?.properties ?? {};

  return (
    <div className="flex flex-col h-full w-full bg-[#f0ece3] font-serif overflow-hidden">
      {/* ══ TOP BAR ══ */}
      <header className="flex items-center px-4 sm:px-3 h-18 bg-[#0d1f35] border-b border-[rgba(196,160,80,0.2)] shrink-0 gap-0">
        <div className="shrink-0 flex items-center mr-2 mt-3 sm:mr-3">
          <SaltLogo size="sm" />
          <SaltLogoFallback size="sm" />
        </div>
        <div className="hidden sm:block w-px h-10 bg-[rgba(196,160,80,0.25)] shrink-0 mr-4" />
        <div className="flex flex-col leading-none">
          <span className="text-base sm:text-lg font-bold tracking-[0.18em] text-[#f0ece3]">
            <span className="text-[#c4a050]">SALT</span> ATLAS
          </span>
          <span className="hidden sm:block text-[0.68rem] tracking-[0.2em] uppercase text-[rgba(196,160,80,0.75)] mt-1">
            Supply Chain Opportunity Map
          </span>
        </div>
        <div className="hidden sm:block w-px h-10 bg-[rgba(196,160,80,0.12)] shrink-0 mx-4" />
        <div className="hidden sm:flex flex-col leading-none">
          <span className="text-[0.68rem] tracking-[0.18em] uppercase text-[rgba(240,236,227,0.5)]">
            Coverage
          </span>
          <span className="text-sm font-semibold text-[#f0ece3] mt-0.5">
            United States · County Level
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {siteAuthRequired ? (
            <button
              type="button"
              onClick={() => {
                clearSessionToken();
                setSiteAuthPhase("login");
                setLoading(false);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[rgba(240,236,227,0.28)] text-[#f0ece3] text-xs tracking-[0.1em] font-semibold hover:bg-[rgba(240,236,227,0.08)] transition-colors font-serif cursor-pointer text-sm font-medium"
            >
              Sign out
            </button>
          ) : null}
          <button
            onClick={() => {
              setHelpStep(0);
              setShowHelp(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[rgba(240,236,227,0.28)] text-[#f0ece3] text-xs tracking-[0.1em] font-semibold hover:bg-[rgba(240,236,227,0.08)] transition-colors font-serif cursor-pointer text-sm font-medium"
          >
            <span className="text-[0.85rem]">ⓘ</span>
            <span className="hidden sm:inline">Guide</span>
          </button>
          <button
            onClick={handleExportCSV}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 sm:px-4 py-2 border border-[rgba(240,236,227,0.28)] text-[#f0ece3] rounded text-xs tracking-[0.1em] uppercase font-semibold hover:bg-[rgba(240,236,227,0.08)] transition-colors font-serif cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:pointer-events-none"
          >
            <span>↓</span>
            <span className="hidden sm:inline">Export CSV</span>
          </button>
          <button
            onClick={handleTopRegions}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 sm:px-5 py-2 bg-[#c4a050] text-[#0d1f35] rounded text-xs tracking-[0.1em] uppercase font-bold hover:bg-[#d4b060] transition-colors font-serif cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:pointer-events-none"
          >
            <span>◆</span>
            <span className="hidden sm:inline">Show Top Regions</span>
          </button>
        </div>
      </header>

      {bootstrapError && (
        <div
          role="alert"
          className="shrink-0 px-4 py-2.5 bg-[#fff7ed] border-b border-[rgba(196,160,80,0.45)] text-[#422006] text-sm font-serif flex flex-wrap items-center gap-3 justify-between"
        >
          <span>{bootstrapError}</span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="shrink-0 px-3 py-1 rounded border border-[rgba(66,32,6,0.35)] text-xs font-semibold uppercase tracking-wide hover:bg-white/80 cursor-pointer"
          >
            Reload
          </button>
        </div>
      )}

      {/* ══ SECOND BAR ══ */}
      <div className="flex items-center px-3 sm:px-5 py-2 sm:py-2.5 bg-[#f5f1e8] border-b border-[rgba(13,31,53,0.1)] shrink-0 gap-2 sm:gap-3 overflow-x-auto min-h-[48px] sm:min-h-[52px]">
        <button
          onClick={handleFullReset}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 sm:px-3.5 py-1.5 sm:py-2 border border-[rgba(13,31,53,0.25)] text-[#0d1f35] rounded text-xs tracking-[0.08em] uppercase font-semibold hover:bg-[rgba(13,31,53,0.05)] transition-colors font-serif cursor-pointer shrink-0 disabled:opacity-35 disabled:cursor-not-allowed disabled:pointer-events-none"
        >
          ↺ <span className="hidden sm:inline">Reset</span>
        </button>

        <button
          onClick={() => setFiltersOpen((o) => !o)}
          disabled={loading}
          className={`hidden sm:flex items-center gap-1.5 px-3.5 py-1.5 sm:py-2 border rounded text-xs tracking-[0.08em] uppercase font-semibold transition-colors font-serif cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed disabled:pointer-events-none ${
            filtersOpen
              ? "bg-[#0d1f35] border-[#0d1f35] text-[#c4a050]"
              : "bg-transparent border-[rgba(13,31,53,0.25)] text-[#0d1f35] hover:bg-[rgba(13,31,53,0.05)]"
          }`}
        >
          ⇄ Filters
          {activeFiltersCount > 0 && (
            <span className="text-[#c4a050] ml-0.5 font-bold">
              ({activeFiltersCount})
            </span>
          )}
        </button>

        <button
          onClick={handleInfraToggleAll}
          disabled={loading}
          className={`flex items-center gap-1.5 px-3 sm:px-3.5 py-1.5 sm:py-2 border rounded text-xs tracking-[0.08em] uppercase font-semibold transition-colors font-serif cursor-pointer shrink-0 disabled:opacity-35 disabled:cursor-not-allowed disabled:pointer-events-none ${
            infraAllVisible
              ? "bg-[#0d1f35] border-[#0d1f35] text-[#c4a050]"
              : "bg-transparent border-[rgba(13,31,53,0.25)] text-[#0d1f35] hover:bg-[rgba(13,31,53,0.05)]"
          }`}
        >
          ✈ <span className="hidden sm:inline ml-1">Infra</span>
        </button>

        <button
          onClick={() => {
            const next = !selectionMode;
            setSelectionMode(next);
            selectionModeRef.current = next;
            if (!next) clearSelections();
            showToast(
              next ? "Click counties to select" : "Selection cleared",
              1800
            );
          }}
          disabled={loading}
          className={`flex items-center gap-1.5 px-3 sm:px-3.5 py-1.5 sm:py-2 border rounded text-xs tracking-[0.08em] uppercase font-semibold transition-colors font-serif cursor-pointer shrink-0 disabled:opacity-35 disabled:cursor-not-allowed disabled:pointer-events-none ${
            selectionMode
              ? "bg-[#c4a050] border-[#c4a050] text-[#0d1f35] font-bold"
              : "bg-transparent border-[rgba(13,31,53,0.25)] text-[#0d1f35] hover:bg-[rgba(13,31,53,0.05)]"
          }`}
        >
          <span>▣</span>
          <span className="hidden sm:inline ml-1">Select Regions</span>
          {hasSelection && (
            <span className="text-[0.68rem] ml-0.5 font-bold">
              ({selectedFeatures.length})
            </span>
          )}
        </button>

        <div className="flex items-center gap-1 sm:gap-1.5 ml-auto">
          <span className="hidden sm:block text-[0.7rem] tracking-[0.12em] uppercase text-gray-500 font-semibold mr-1">
            View Layer
          </span>
          {Object.entries(layerLabel).map(([key, label]) => (
            <button
              key={key}
              onClick={() => handleLayerChange(key)}
              disabled={loading}
              className={`flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded text-xs sm:text-[0.78rem] font-semibold transition-colors font-serif cursor-pointer shrink-0 disabled:opacity-35 disabled:cursor-not-allowed disabled:pointer-events-none ${
                activeLayer === key
                  ? "bg-[#0d1f35] text-[#f0ece3]"
                  : "text-[rgba(13,31,53,0.65)] hover:bg-[rgba(13,31,53,0.06)]"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  activeLayer === key
                    ? "bg-[#c4a050]"
                    : "bg-[rgba(13,31,53,0.3)]"
                }`}
              />
              <span className="hidden sm:inline">{label}</span>
              <span className="sm:hidden">{label.split(" ")[0]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ══ BODY ══ */}
      <div className="flex-1 overflow-hidden relative">
        {/* Desktop filter sidebar - only rendered on desktop */}
        {filtersOpen && isDesktop && (
          <aside className="absolute top-0 left-0 bottom-0 z-[20] w-72 lg:w-96 overflow-hidden bg-[#f5f1e8] border-r border-[rgba(13,31,53,0.1)] animate-fade-slide">
            <div className="w-full h-full flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-5 lg:p-7">
                <FilterPanelContent
                  dataBounds={dataBounds}
                  filters={filters}
                  loading={loading}
                  activeFiltersCount={activeFiltersCount}
                  handleSliderChange={handleSliderChange}
                  handleResetFilters={() => {
                    resetFiltersToMax();
                    showToast("Filters reset", 1400);
                  }}
                  onClose={() => setFiltersOpen(false)}
                  filterTransitAgenciesOnly={filterTransitAgenciesOnly}
                  onTransitAgenciesToggle={handleTransitAgenciesToggle}
                />
              </div>
            </div>
          </aside>
        )}

        {/* Map */}
        <section className="absolute inset-0 overflow-hidden map-panel">
          {/* Loading overlay */}
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[rgba(240,236,227,0.94)] z-20 gap-5 animate-fade-slide">
              <div className="relative w-16 h-16 flex items-center justify-center">
                <SaltLogo size="lg" />
                <SaltLogoFallback size="md" />
              </div>
              <LoadingSpinner />
            </div>
          )}

          {/* Map updating indicator */}
          <div
            className="absolute inset-0 flex items-center justify-center z-10 transition-opacity duration-200 pointer-events-none"
            style={{
              opacity: isUpdatingMap && !loading ? 1 : 0,
              backdropFilter: isUpdatingMap ? "blur(1.5px)" : "none",
              background: isUpdatingMap
                ? "rgba(240,236,227,0.45)"
                : "transparent",
            }}
          >
            <div className="flex items-center gap-2.5 bg-white rounded-md px-5 py-2.5 shadow-lg text-[#0d1f35] text-[0.84rem] font-semibold font-serif tracking-wide pointer-events-none">
              <div className="w-4 h-4 rounded-full border-2 border-[rgba(13,31,53,0.15)] border-t-[#0d1f35] animate-spin-custom" />
              Updating map…
            </div>
          </div>

          {/* Selection badge */}
          {!loading && !mapOverlaysHidden && hasSelection && (
            <div
              className={`absolute top-3 z-[25] flex items-baseline gap-2 bg-white/95 rounded-md px-3 py-2 sm:px-3.5 sm:py-2.5 shadow-md animate-fade-slide transition-all duration-200 ${
                filtersOpen && isDesktop
                  ? "left-[300px] lg:left-[396px]"
                  : "left-3"
              }`}
            >
              <span className="text-2xl sm:text-3xl font-bold text-[#0d1f35] font-serif leading-none">
                {selectedFeatures.length}
              </span>
              <div className="flex flex-col">
                <span className="text-[0.7rem] sm:text-[0.72rem] tracking-[0.15em] uppercase text-gray-500 font-semibold">
                  Selected
                </span>
                <span className="text-xs sm:text-[0.75rem] font-semibold text-[#c4a050]">
                  ↑ {layerLabel[activeLayer]}
                </span>
              </div>
            </div>
          )}

          {/* Map controls */}
          {!loading && !mapOverlaysHidden && (
            <div
              className={`absolute top-20 z-[6] flex flex-col gap-3 transition-all duration-200 ${
                filtersOpen && isDesktop
                  ? "left-[300px] lg:left-[396px]"
                  : "left-3"
              }`}
            >
              <button
                onClick={() => mapRef.current?.zoomIn()}
                className="w-12 h-12 bg-white rounded-xl shadow-md flex items-center justify-center text-xl text-[#0d1f35] hover:bg-gray-100"
              >
                +
              </button>
              <button
                onClick={() => mapRef.current?.zoomOut()}
                className="w-12 h-12 bg-white rounded-xl shadow-md flex items-center justify-center text-xl text-[#0d1f35] hover:bg-gray-100"
              >
                −
              </button>
              <button
                onClick={handleRecenter}
                className="w-12 h-12 bg-white rounded-xl shadow-md flex items-center justify-center text-[#0d1f35] hover:bg-gray-100"
              >
                ⌂
              </button>
            </div>
          )}

          {/* Right-side map overlays */}
          <div
            className={`absolute top-0 right-0 bottom-0 pointer-events-none transition-all duration-200 ${
              selectedRegion && isDesktop
                ? "right-[clamp(272px,20vw,360px)]"
                : "right-0"
            }`}
          >
            {/* Infra legend */}
            {!loading && showInfraLegend && !mapOverlaysHidden && (
              <InfraLegend
                poiLayers={poiLayers}
                onToggle={handlePoiToggle}
                disabled={mapOverlaysHidden}
              />
            )}

            {/* Eye button */}
            {!loading && (
              <button
                onClick={() => setMapOverlaysHidden((h) => !h)}
                className="absolute z-[6] rounded-md px-2.5 py-2 shadow-md hover:opacity-90 transition-opacity cursor-pointer pointer-events-auto"
                style={{
                  bottom: 52,
                  right: 12,
                  background: "rgba(10,26,47,0.85)",
                  backdropFilter: "blur(8px)",
                  border: "1px solid rgba(196,160,80,0.2)",
                }}
              >
                {mapOverlaysHidden ? (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#c4a050"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                ) : (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#c4a050"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                )}
              </button>
            )}
          </div>
          {/* end right-side overlay wrapper */}

          {/* Legend bar */}
          {!loading && !mapOverlaysHidden && (
            <div className="absolute bottom-14 sm:bottom-3 left-1/2 -translate-x-1/2 z-[5] flex items-center gap-2 sm:gap-2.5 bg-white/92 rounded px-3 sm:px-4 py-1.5 sm:py-2 shadow-md text-[0.68rem] sm:text-[0.72rem] tracking-[0.1em] uppercase text-gray-600 whitespace-nowrap">
              <span>{layerLabel[activeLayer].toUpperCase()}</span>
              <span className="text-gray-400">Low</span>
              <div
                className="w-20 sm:w-28 h-1.5 rounded-full"
                style={{ background: "linear-gradient(90deg,#bfdbfe,#1e3a8a)" }}
              />
              <span className="text-gray-400">High</span>
            </div>
          )}

          <div
            ref={mapContainer}
            className="w-full h-full map-container"
            aria-label="Opportunity map"
          />
        </section>

        {/* Right detail panel */}
        {selectedRegion && isDesktop && (
          <aside
            className="absolute top-0 right-0 bottom-0 z-[20] flex flex-col overflow-hidden bg-[#f5f1e8] border-l border-[rgba(13,31,53,0.1)] animate-fade-slide"
            style={{
              width: "clamp(272px, 20vw, 360px)",
              maxWidth: "30vw",
            }}
          >
            <RegionDetailPanel p={p} onClose={() => setSelectedRegion(null)} />
          </aside>
        )}
      </div>

      {/* Mobile filter sheet */}
      <MobileFilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
      >
        <FilterPanelContent
          dataBounds={dataBounds}
          filters={filters}
          loading={loading}
          activeFiltersCount={activeFiltersCount}
          handleSliderChange={handleSliderChange}
          handleResetFilters={() => {
            resetFiltersToMax();
            showToast("Filters reset", 1400);
          }}
          onClose={() => setFiltersOpen(false)}
          filterTransitAgenciesOnly={filterTransitAgenciesOnly}
          onTransitAgenciesToggle={handleTransitAgenciesToggle}
        />
      </MobileFilterSheet>

      {/* Mobile region detail sheet */}
      <div
        className="sm:hidden fixed inset-0 z-[150]"
        style={{ pointerEvents: selectedRegion ? "auto" : "none" }}
      >
        <div
          className="absolute inset-0 bg-black/30 transition-opacity duration-300"
          style={{ opacity: selectedRegion ? 1 : 0 }}
          onClick={() => setSelectedRegion(null)}
        />
        <div
          className="absolute bottom-0 left-0 right-0 bg-[#f5f1e8] rounded-t-2xl shadow-2xl transition-transform duration-300 flex flex-col"
          style={{
            maxHeight: "72vh",
            transform: selectedRegion ? "translateY(0)" : "translateY(100%)",
          }}
        >
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="w-10 h-1 bg-[rgba(13,31,53,0.2)] rounded-full" />
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain">
            {selectedRegion && (
              <RegionDetailPanel
                p={p}
                onClose={() => setSelectedRegion(null)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Mobile action bar */}
      <div className="sm:hidden flex items-stretch h-12 bg-[#0d1f35] border-t border-[rgba(196,160,80,0.15)] shrink-0">
        {[
          {
            icon: "⇄",
            label: `Filters${
              activeFiltersCount > 0 ? ` (${activeFiltersCount})` : ""
            }`,
            action: () => setFiltersOpen(true),
          },
          { icon: "◆", label: "Top 20", action: handleTopRegions },
          {
            icon: "▣",
            label: `Select${
              hasSelection ? ` (${selectedFeatures.length})` : ""
            }`,
            action: () => {
              const n = !selectionMode;
              setSelectionMode(n);
              selectionModeRef.current = n;
              if (!n) clearSelections();
            },
            active: selectionMode,
          },
          { icon: "↺", label: "Reset", action: handleFullReset },
          { icon: "↓", label: "Export", action: handleExportCSV },
        ].map(({ icon, label, action, active }, i) => (
          <div key={label} className="flex flex-1">
            {i > 0 && <div className="w-px bg-[rgba(196,160,80,0.15)]" />}
            <button
              onClick={action}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                active
                  ? "text-[#c4a050]"
                  : "text-[rgba(240,236,227,0.7)] hover:text-[#c4a050]"
              }`}
            >
              <span className="text-base">{icon}</span>
              <span className="text-[0.62rem] font-semibold tracking-[0.06em] uppercase">
                {label}
              </span>
            </button>
          </div>
        ))}
      </div>

      {/* Status bar */}
      <footer className="hidden sm:flex items-center px-5 h-8 lg:h-10 bg-[#0d1f35] border-t border-[rgba(196,160,80,0.15)] shrink-0 gap-5 lg:gap-7">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] status-dot-live" />
          <span className="text-[0.68rem] lg:text-[0.74rem] tracking-[0.12em] uppercase text-[rgba(240,236,227,0.6)] font-semibold">
            Status
          </span>
          <span className="text-[0.72rem] lg:text-[0.8rem] font-medium text-[rgba(240,236,227,0.85)]">
            Live
          </span>
        </div>
        {[
          ["Coverage", "United States · County Level"],
          ["Layer", layerLabel[activeLayer]],
          ["Source", "2022 · CBP + QCEW"],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center gap-1.5">
            <span className="text-[0.68rem] lg:text-[0.74rem] tracking-[0.12em] uppercase text-[rgba(240,236,227,0.6)] font-semibold">
              {k}
            </span>
            <span className="text-[0.72rem] lg:text-[0.8rem] font-medium text-[rgba(240,236,227,0.85)]">
              {v}
            </span>
          </div>
        ))}
        <span className="ml-auto text-[0.65rem] lg:text-[0.72rem] tracking-[0.12em] uppercase text-[rgba(240,236,227,0.45)]">
          Build v1.0.0
        </span>
      </footer>

      {/* Hover card */}
      <HoverCard
        feature={hoverFeature}
        position={hoverPosition}
        visible={!!hoverFeature}
      />

      {/* Toast */}
      <Toast message={toast.message} visible={toast.visible} />

      {/* Help modal */}
      {showHelp && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
          onClick={() => setShowHelp(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[420px] max-w-[92%] bg-white rounded-xl shadow-2xl p-6 flex flex-col animate-modalIn"
          >
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-base font-semibold text-[#0d1f35]">
                {HELP_STEPS[helpStep].title}
              </h2>
              <button
                onClick={() => setShowHelp(false)}
                className="text-base text-gray-400 hover:text-gray-600 transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="text-sm text-gray-600 leading-relaxed space-y-2 min-h-[100px] transition-all duration-200">
              {HELP_STEPS[helpStep].body}
            </div>
            <div className="flex items-center justify-between mt-5">
              <button
                disabled={helpStep === 0}
                onClick={() => setHelpStep((p) => p - 1)}
                className="text-sm text-gray-500 disabled:opacity-30"
              >
                ← Back
              </button>
              <div className="flex gap-1">
                {HELP_STEPS.map((_, i) => (
                  <div
                    key={i}
                    className={`h-1.5 w-5 rounded-full transition-all ${
                      i === helpStep ? "bg-[#c4a050]" : "bg-gray-300"
                    }`}
                  />
                ))}
              </div>
              <button
                onClick={() => {
                  if (helpStep === HELP_STEPS.length - 1) setShowHelp(false);
                  else setHelpStep((p) => p + 1);
                }}
                className="text-sm font-semibold text-[#c4a050]"
              >
                {helpStep === HELP_STEPS.length - 1 ? "Done" : "Next →"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
