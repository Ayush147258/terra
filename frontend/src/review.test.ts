import { describe, it, expect, vi } from "vitest";
import { controlsFor, canReject, statusDetail, historyLines, approve, reject, STATE_LABEL, Review } from "./review";
import { layerVisibility } from "./recon";
const ok = (b: unknown) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => b }) as unknown as typeof fetch;
const R = (o: Partial<Review>): Review => ({ parcel_id: "DEMO-018", state: "CANDIDATE_READY", latest_version: 2, reviewer: "Human Reviewer", decisions: [], verified: null, history: [], validations: [], ...o });
describe("state-dependent controls", () => {
  it("offers only non-contradictory actions per state", () => {
    expect(controlsFor("UNREVIEWED", false)).toEqual([]); expect(controlsFor("CANDIDATE_READY", false)).toEqual(["edit", "review"]);
    expect(controlsFor("IN_REVIEW", false)).toEqual(["approve", "reject", "edit"]); expect(controlsFor("REJECTED", false)).toEqual(["edit"]);
    expect(controlsFor("VERIFIED", false)).toEqual(["view"]); expect(controlsFor("IN_REVIEW", true)).toEqual([]);
  });
});
describe("review actions call the backend", () => {
  it("approve posts version + note", async () => {
    const f = ok(R({ state: "VERIFIED" })); const r = await approve("DEMO-018", 3, "fine", f);
    expect(f).toHaveBeenCalledWith("/api/review/DEMO-018/approve", expect.objectContaining({ method: "POST", body: JSON.stringify({ version: 3, note: "fine" }) })); expect(r.state).toBe("VERIFIED");
  });
  it("reject requires a reason in UI and posts it", async () => {
    expect(canReject("")).toBe(false); expect(canReject("  ")).toBe(false); expect(canReject("Boundary inconsistent")).toBe(true);
    const f = ok(R({ state: "REJECTED" })); await reject("DEMO-018", 2, "Boundary inconsistent", f);
    expect(JSON.parse((f as any).mock.calls[0][1].body)).toEqual({ version: 2, reason: "Boundary inconsistent" });
  });
  it("surfaces backend transition errors", async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ detail: "Cannot approve: state is REJECTED" }) }) as unknown as typeof fetch;
    await expect(approve("DEMO-018", 1, "", f)).rejects.toThrow("Cannot approve");
  });
});
describe("status + history + verified layer", () => {
  it("status text communicates lifecycle", () => {
    expect(STATE_LABEL.CANDIDATE_READY).toBe("PENDING HUMAN REVIEW"); expect(statusDetail(null)).toBe("No candidate reviewed yet.");
    expect(statusDetail(R({ state: "REJECTED", decisions: [{ id: "RD-1", candidate_version: 2, decision: "REJECTED", reason: "Too loose", created_at: "" }] }))).toBe("Candidate v2 rejected. Reason: Too loose");
    expect(statusDetail(R({ state: "VERIFIED", verified: { verified_geometry: {}, source_candidate_version: 3, review_decision_id: "RD-2" } }))).toBe("Candidate v3 approved by human review and passed PostGIS validation.");
  });
  it("history renders stored events in order", () => {
    const l = historyLines([{ event: "Candidate rejected", parcel_id: "P", version: 2, timestamp: "2026-09-28T09:45:10", detail: "Too loose" }, { event: "VERIFIED_GEOMETRY_CREATED", parcel_id: "P", version: 3, timestamp: "2026-09-28T09:50:00" }]);
    expect(l).toEqual([{ time: "09:45", text: "Candidate v2 rejected", detail: "Too loose" }, { time: "09:50", text: "Candidate v3 verified geometry created", detail: undefined }]);
  });
  it("verified layer follows its toggle", () => {
    const on = { imagery: true, recorded: true, observed: true, candidate: true, discrepancy: true, verified: true };
    expect(layerVisibility(on)["ver-line"]).toBe("visible"); expect(layerVisibility({ ...on, verified: false })["ver-fill"]).toBe("none");
  });
});
import { runValidation, latestValidation, validationHeadline, verifiedNote, checkLabel, CHECK_MARK, Validation } from "./review";
const V = (o: Partial<Validation>): Validation => ({ id: 1, candidate_version: 3, status: "VALID", checks: [{ check: "GEOMETRY_VALIDITY", status: "PASS", message: "Geometry is valid" }], errors: [], warnings: [], overlap_geometry: null, validated_at: "", ...o });
describe("PostGIS validation UI state", () => {
  it("post-approval state offers validation, never verified", () => {
    expect(controlsFor("APPROVED_PENDING_VALIDATION", false)).toEqual(["validate"]); expect(controlsFor("CANDIDATE_REVIEW_REQUIRED", false)).toEqual(["edit"]);
    expect(statusDetail(R({ state: "APPROVED_PENDING_VALIDATION" }))).toMatch(/Not verified/);
  });
  it("loading state, pass, warning and failure headlines", () => {
    expect(validationHeadline(null, true)).toBe("VALIDATING…"); expect(validationHeadline(V({}), false)).toBe("VALIDATION PASSED");
    expect(validationHeadline(V({ status: "WARNING" }), false)).toBe("VALIDATION PASSED WITH WARNINGS"); expect(validationHeadline(V({ status: "INVALID" }), false)).toBe("VALIDATION FAILED");
  });
  it("verified geometry note follows validation result; failed state text", () => {
    expect(verifiedNote(V({}))).toBe("VERIFIED GEOMETRY: AVAILABLE"); expect(verifiedNote(V({ status: "INVALID" }))).toBe("VERIFIED GEOMETRY: NOT CREATED");
    expect(statusDetail(R({ state: "CANDIDATE_REVIEW_REQUIRED" }))).toMatch(/Verified geometry NOT created/);
  });
  it("check display + latest validation", () => {
    expect(CHECK_MARK.FAIL).toBe("✕"); expect(checkLabel("NEIGHBOUR_OVERLAP")).toBe("Neighbour overlap");
    expect(latestValidation(R({ validations: [V({ id: 1 }), V({ id: 2, status: "INVALID" })] }))!.id).toBe(2); expect(latestValidation(R({}))).toBeNull();
  });
  it("validation request posts candidate_version; backend errors surface", async () => {
    const f = ok({ ...V({}), verified: true }); await runValidation("DEMO-001", 3, f);
    expect(f).toHaveBeenCalledWith("/api/validation/DEMO-001", expect.objectContaining({ body: JSON.stringify({ candidate_version: 3 }) }));
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ detail: "Cannot validate: state is IN_REVIEW" }) }) as unknown as typeof fetch;
    await expect(runValidation("DEMO-001", 3, bad)).rejects.toThrow("Cannot validate");
  });
  it("audit/provenance lines render new event codes; backend-down message", async () => {
    const l = historyLines([{ event: "VALIDATION_FAILED", parcel_id: "P", version: 3, timestamp: "2026-09-28T09:50:00", detail: "Unexpected overlap with DEMO-024" }, { event: "CANDIDATE_APPROVED", parcel_id: "P", version: 3, timestamp: "2026-09-28T09:49:00" }]);
    expect(l[0]).toEqual({ time: "09:50", text: "Candidate v3 PostGIS validation failed", detail: "Unexpected overlap with DEMO-024" }); expect(l[1].text).toBe("Candidate v3 approved by human");
    const { safeFetch, BACKEND_DOWN } = await import("./api"); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(safeFetch("/api/x")).rejects.toThrow(BACKEND_DOWN); vi.unstubAllGlobals();
  });
});
