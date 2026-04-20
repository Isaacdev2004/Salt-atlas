const API_BASE = import.meta.env.VITE_API_URL;

// If not provided, assume same-origin (works in production with proxy / same server)
export const getApiBase = () => {
  if (API_BASE) return API_BASE;

  // fallback: same origin
  return window.location.origin;
};
