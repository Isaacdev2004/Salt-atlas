const API_BASE = import.meta.env.VITE_API_URL;
const TOKEN_KEY = "salt_atlas_session";

// If not provided, assume same-origin (works in production with proxy / same server)
export const getApiBase = () => {
  if (API_BASE) return API_BASE.replace(/\/$/, "");

  // fallback: same origin
  return window.location.origin.replace(/\/$/, "");
};

export function getSessionToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setSessionToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore private mode */
  }
}

export function clearSessionToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Authenticated API fetch (Bearer session from site login).
 * @param {string} path - Absolute path on API host, e.g. "/api/regions"
 * @param {RequestInit} [options]
 */
export async function apiFetch(path, options = {}) {
  const base = getApiBase();
  const rel = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${rel}`;
  const headers = new Headers(options.headers || {});
  const tok = getSessionToken();
  if (tok) headers.set("Authorization", `Bearer ${tok}`);
  if (
    options.body &&
    typeof options.body === "string" &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...options, headers });
}
