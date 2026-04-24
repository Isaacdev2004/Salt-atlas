const API_BASE = import.meta.env.VITE_API_URL;
const TOKEN_KEY = "salt_atlas_session";

// If not provided, assume same-origin (works in production with proxy / same server)
export const getApiBase = () => {
  if (API_BASE) return API_BASE.replace(/\/$/, "");

  // fallback: same origin
  return window.location.origin.replace(/\/$/, "");
};

function readToken() {
  try {
    return (
      localStorage.getItem(TOKEN_KEY) ||
      sessionStorage.getItem(TOKEN_KEY) ||
      ""
    );
  } catch {
    return "";
  }
}

export function getSessionToken() {
  return readToken();
}

export function setSessionToken(token) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      sessionStorage.removeItem(TOKEN_KEY);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* ignore private mode */
  }
}

export function clearSessionToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
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

/** Regions bootstrap: retry for cold Render / flaky networks */
export async function fetchRegionsWithRetry(maxAttempts = 4, delayMs = 1800) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await apiFetch("/api/regions");
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Auth bootstrap: same-origin `/api/auth-status` can hang on cold Render / flaky networks.
 * Uses per-attempt timeout so the UI never stays on “Checking access…” indefinitely.
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=5]
 * @param {number} [opts.delayMs=1000]
 * @param {number} [opts.timeoutMs=12000]
 */
export async function fetchAuthStatusWithRetry(opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 5;
  const delayMs = opts.delayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 12000;
  const base = getApiBase();
  const url = `${base.replace(/\/$/, "")}/api/auth-status`;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}
