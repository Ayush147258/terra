import { apiUrl, safeFetch } from "./api";
export type RState = "UNREVIEWED" | "CANDIDATE_READY" | "IN_REVIEW" | "REJECTED" | "APPROVED_PENDING_VALIDATION" | "CANDIDATE_REVIEW_REQUIRED" | "VERIFIED";
export type Action = "edit" | "review" | "approve" | "reject" | "view" | "validate";
export interface Decision { id: string; candidate_version: number; decision: "APPROVED" | "REJECTED"; reason: string; created_at: string }
export interface HistEvent { event: string; parcel_id: string; version: number; timestamp: string; detail?: string | null }
export interface CheckItem { check: string; status: "PASS" | "WARN" | "FAIL" | "SKIP"; message: string }
export interface Validation { id: number; candidate_version: number; status: "VALID" | "WARNING" | "INVALID"; checks: CheckItem[]; errors: string[]; warnings: string[]; overlap_geometry: any | null; validated_at: string; verified?: boolean }
export interface Review { parcel_id: string; state: RState; latest_version: number; reviewer: string; decisions: Decision[];
  verified: { verified_geometry: any; source_candidate_version: number; review_decision_id: string; validation_status?: string } | null; history: HistEvent[]; validations: Validation[] }
export const STATE_LABEL: Record<RState, string> = { UNREVIEWED: "UNREVIEWED", CANDIDATE_READY: "PENDING HUMAN REVIEW", IN_REVIEW: "IN HUMAN REVIEW", REJECTED: "REJECTED", APPROVED_PENDING_VALIDATION: "APPROVED — PENDING POSTGIS VALIDATION", CANDIDATE_REVIEW_REQUIRED: "VALIDATION FAILED — REVIEW REQUIRED", VERIFIED: "VERIFIED" };
const MAP: Record<RState, Action[]> = { UNREVIEWED: [], CANDIDATE_READY: ["edit", "review"], IN_REVIEW: ["approve", "reject", "edit"], REJECTED: ["edit"], APPROVED_PENDING_VALIDATION: ["validate"], CANDIDATE_REVIEW_REQUIRED: ["edit"], VERIFIED: ["view"] };
/** Which controls are offered. Backend enforces the same transitions; this only avoids offering contradictory actions. */
export const controlsFor = (s: RState, editing: boolean): Action[] => (editing ? [] : MAP[s]);
export const canReject = (reason: string) => reason.trim().length >= 3;
export function statusDetail(r: Review | null): string {
  if (!r || r.state === "UNREVIEWED") return "No candidate reviewed yet.";
  const last = r.decisions[r.decisions.length - 1];
  switch (r.state) {
    case "CANDIDATE_READY": return `Candidate v${r.latest_version} requires a human decision.`;
    case "IN_REVIEW": return `Candidate v${r.latest_version} is under human review.`;
    case "REJECTED": return `Candidate v${last?.candidate_version} rejected. Reason: ${last?.reason}`;
    case "APPROVED_PENDING_VALIDATION": return `Candidate v${r.latest_version} approved by a human; PostGIS validation has not completed. Not verified.`;
    case "CANDIDATE_REVIEW_REQUIRED": return `Human approval recorded, but PostGIS validation failed. Verified geometry NOT created. Edit the candidate to continue.`;
    case "VERIFIED": return `Candidate v${r.verified?.source_candidate_version} approved by human review and passed PostGIS validation${r.verified?.validation_status === "WARNING" ? " (with warnings)" : ""}.`;
  }
}
const EVENT_TEXT: Record<string, string> = { CANDIDATE_APPROVED: "approved by human", VALIDATION_STARTED: "PostGIS validation started", VALIDATION_COMPLETED: "PostGIS validation completed", VALIDATION_FAILED: "PostGIS validation failed", VERIFIED_GEOMETRY_CREATED: "verified geometry created" };
export const historyLines = (h: HistEvent[]) => h.map(e => ({ time: e.timestamp.slice(11, 16), text: EVENT_TEXT[e.event] ? `Candidate v${e.version} ${EVENT_TEXT[e.event]}` : `Candidate v${e.version} ${e.event.replace(/^Candidate /, "")}`, detail: e.detail ?? undefined }));
export const latestValidation = (r: Review | null) => (r && r.validations.length ? r.validations[r.validations.length - 1] : null);
export const validationHeadline = (v: Validation | null, busy: boolean) => busy ? "VALIDATING…" : !v ? "" : v.status === "VALID" ? "VALIDATION PASSED" : v.status === "WARNING" ? "VALIDATION PASSED WITH WARNINGS" : "VALIDATION FAILED";
export const verifiedNote = (v: Validation | null) => (v && v.status !== "INVALID" ? "VERIFIED GEOMETRY: AVAILABLE" : "VERIFIED GEOMETRY: NOT CREATED");
export const CHECK_MARK = { PASS: "✓", WARN: "⚠", FAIL: "✕", SKIP: "–" } as const;
export const checkLabel = (c: string) => c.replace(/_/g, " ").toLowerCase().replace(/^./, x => x.toUpperCase());
async function call<T>(url: string, body?: unknown, f: typeof fetch = safeFetch): Promise<T> {
  const res = await f(apiUrl(url), body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) { let m = `Request failed (${res.status})`; try { const d = (await res.json()).detail; if (typeof d === "string") m = d; } catch { /* default */ } throw new Error(m); }
  return res.json();
}
export const getReview = (id: string, f: typeof fetch = safeFetch) => call<Review>(`/api/review/${id}`, undefined, f);
export const submitReview = (id: string, version: number, f: typeof fetch = safeFetch) => call<Review>(`/api/review/${id}/submit`, { version }, f);
export const approve = (id: string, version: number, note: string, f: typeof fetch = safeFetch) => call<Review>(`/api/review/${id}/approve`, { version, note }, f);
export const reject = (id: string, version: number, reason: string, f: typeof fetch = safeFetch) => call<Review>(`/api/review/${id}/reject`, { version, reason }, f);
export const getVerified = (f: typeof fetch = safeFetch) => call<{ type: "FeatureCollection"; features: any[] }>("/api/verified", undefined, f);

export const runValidation = (id: string, version: number, f: typeof fetch = safeFetch) => call<Validation & { verified: boolean }>(`/api/validation/${id}`, { candidate_version: version }, f);
