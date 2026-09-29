import { apiUrl, safeFetch } from "./api";
export type Status = "MATCH" | "MINOR_DISCREPANCY" | "MAJOR_DISCREPANCY";
export interface Recon {
  parcel_id: string; recorded_area: number; observed_area: number; area_difference: number; area_difference_percent: number;
  intersection_area: number; overlap_percent: number; symmetric_difference_area: number; boundary_deviation: number;
  discrepancy_status: Status; discrepancy_reasons: string[]; observed_geometry: any; candidate_geometry: any;
  discrepancy_geometry: any | null; candidate_status: string; recorded_geometry: any;
}
export const STATUS_LABEL: Record<Status, string> = { MATCH: "MATCH", MINOR_DISCREPANCY: "MINOR DISCREPANCY", MAJOR_DISCREPANCY: "MAJOR DISCREPANCY" };
export const STATUS_SHORT: Record<Status, string> = { MATCH: "MATCH", MINOR_DISCREPANCY: "MINOR", MAJOR_DISCREPANCY: "MAJOR" };
export const signed = (n: number, unit: string, d = 1) => `${n > 0 ? "+" : ""}${n.toFixed(d)}${unit}`;
export const hasDiscrepancy = (r: Recon | null) => !!r && !!r.discrepancy_geometry && r.discrepancy_status !== "MATCH";
export const GROUPS: Record<string, string[]> = {
  imagery: ["imagery"], recorded: ["rec-fill", "rec-line"], observed: ["obs-fill", "obs-line", "obx-line"],
  candidate: ["cand-fill", "cand-line", "cnd-fill", "cnd-line"], discrepancy: ["dis-fill", "dis-line", "rdis-fill", "rdis-line"],
  verified: ["ver-fill", "ver-line"] };
export const layerVisibility = (vis: Record<string, boolean>) =>
  Object.fromEntries(Object.entries(GROUPS).flatMap(([k, ids]) => ids.map(id => [id, vis[k] ? "visible" : "none"])));
export async function runReconciliation(id: string, f: typeof fetch = safeFetch): Promise<Recon> {
  const res = await f(apiUrl(`/api/reconciliation/${encodeURIComponent(id)}`), { method: "POST" });
  if (!res.ok) { let m = `Reconciliation failed (${res.status})`; try { m = (await res.json()).detail ?? m; } catch { /* keep default */ } throw new Error(m); }
  return res.json();
}

// ---- Phase 3: candidate API ----
export interface Saved { parcel_id: string; candidate_version: number; geometry: any; is_valid: boolean; validation_messages: string[]; status: string; updated_at: string }
export interface Exact { candidate_area: number; area_difference: number; area_difference_percent: number; overlap_percent: number; symmetric_difference_area: number; boundary_deviation: number }
export interface Audit { event: string; parcel_id: string; version: number; timestamp: string }
async function call<T>(f: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const res = await f(apiUrl(url), init);
  if (!res.ok) { let m = `Request failed (${res.status})`; try { const d = (await res.json()).detail; m = typeof d === "string" ? d : m; } catch { /* default */ } throw new Error(m); }
  return res.json();
}
const put = (g: any): RequestInit => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ geometry: g }) });
export const saveCandidate = (id: string, g: any, f: typeof fetch = safeFetch) => call<Saved>(f, `/api/candidates/${id}`, put(g));
export const evaluateCandidate = (id: string, g: any, f: typeof fetch = safeFetch) => call<Exact>(f, `/api/candidates/${id}/evaluate`, { ...put(g), method: "POST" });
export const getSaved = async (id: string, f: typeof fetch = safeFetch): Promise<Saved | null> => { const r = await f(apiUrl(`/api/candidates/${id}`)); return r.ok ? r.json() : null; };
export const getAudit = (f: typeof fetch = safeFetch) => call<Audit[]>(f, "/api/audit");
GROUPS.candidate.push("cbf-line", "edv-pt");
GROUPS.discrepancy.push("ovl-fill", "ovl-line");
