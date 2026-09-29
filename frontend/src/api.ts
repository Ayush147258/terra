// Single place that knows where the backend lives. VITE_API_BASE_URL is PUBLIC (bundled into the browser): never put secrets in it.
// Empty => same origin (Vite dev proxy forwards /api to localhost:8000). Production => https://<deployed-backend-domain>
export const API_BASE: string = ((import.meta as any).env?.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
export const apiUrl = (path: string) => `${API_BASE}${path}`;
export const BACKEND_DOWN = "Backend unavailable — check that the API is running and VITE_API_BASE_URL is correct.";
/** fetch that turns network failures into a readable message instead of a raw TypeError. */
export const safeFetch: typeof fetch = async (input, init) => {
  try { return await fetch(input, init); } catch { throw new Error(BACKEND_DOWN); }
};
