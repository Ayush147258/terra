import { describe, it, expect } from "vitest";
import { editReducer, initialEdit, canSave, vertexFeatures, problems, EditState } from "./edit";
import { liveMetrics, validatePoly, Poly } from "./geo";
const sq = (s = 0.0002): Poly => ({ type: "Polygon", coordinates: [[[80.9, 26.8], [80.9 + s, 26.8], [80.9 + s, 26.8 + s], [80.9, 26.8 + s], [80.9, 26.8]]] });
const loaded = (): EditState => editReducer(initialEdit, { type: "load", geometry: sq(), base: sq(), version: 0 });
const editing = () => editReducer(loaded(), { type: "start" });
const drag = (s: EditState, i: number, lng: number, lat: number) => editReducer(editReducer(s, { type: "beginDrag" }), { type: "move", index: i, lng, lat });
describe("candidate editing state", () => {
  it("activates edit mode and exposes one draggable vertex per corner", () => {
    expect(loaded().editing).toBe(false); const s = editing(); expect(s.editing).toBe(true);
    expect(vertexFeatures(s.current).features).toHaveLength(4);
  });
  it("cannot move vertices outside edit mode", () => {
    const s = editReducer(loaded(), { type: "move", index: 1, lng: 81, lat: 27 }); expect(s.current).toEqual(sq());
  });
  it("vertex movement really changes the geometry (and closes the ring)", () => {
    const s = drag(editing(), 0, 80.8999, 26.7999);
    expect(s.current!.coordinates[0][0]).toEqual([80.8999, 26.7999]); expect(s.current!.coordinates[0][4]).toEqual([80.8999, 26.7999]);
    expect(s.saved).toEqual(sq());
  });
  it("cancel restores the candidate exactly; undo steps back", () => {
    let s = drag(drag(editing(), 1, 80.9003, 26.8), 2, 80.9004, 26.8005);
    expect(editReducer(s, { type: "undo" }).current!.coordinates[0][2]).toEqual(sq().coordinates[0][2]);
    s = editReducer(s, { type: "cancel" }); expect(s.current).toEqual(sq()); expect(s.editing).toBe(false);
  });
  it("self-intersecting edit is invalid and blocks save", () => {
    const s = drag(editing(), 2, 80.8999, 26.8);  // pulls corner across -> bow-tie
    const bow = drag(drag(editing(), 1, 80.9002, 26.8002), 2, 80.9002, 26.8);
    expect(problems(bow).join()).toMatch(/Self-intersection/); expect(canSave(bow)).toBe(false);
    expect(s).toBeDefined(); expect(canSave(drag(editing(), 2, 80.9003, 26.8003))).toBe(true);
  });
  it("save updates candidate state and version", () => {
    const s = editReducer(drag(editing(), 2, 80.9003, 26.8003), { type: "saved", geometry: sq(0.0003), version: 2 });
    expect(s.version).toBe(2); expect(s.editing).toBe(false); expect(s.saved).toEqual(sq(0.0003));
  });
});
describe("live metrics", () => {
  it("identical geometry: zero difference, 100% overlap", () => {
    const m = liveMetrics(sq(), sq()); expect(m.areaDiff).toBeCloseTo(0); expect(m.overlapPct).toBeCloseTo(100, 3); expect(m.deviation).toBeCloseTo(0, 1);
  });
  it("metrics change after a vertex moves; area is in metres (~ 0.0002° ≈ 20 m side)", () => {
    const m0 = liveMetrics(sq(), sq()), m = liveMetrics(sq(), drag(editing(), 2, 80.90025, 26.80025).current!);
    expect(m0.recordedArea).toBeGreaterThan(300); expect(m0.recordedArea).toBeLessThan(500);
    expect(m.areaDiff).toBeGreaterThan(0); expect(m.overlapPct).toBeLessThan(m0.overlapPct + 1e-9); expect(m.deviation).toBeGreaterThan(0.5);
  });
  it("validatePoly rejects wrong type / bad coordinates", () => {
    expect(validatePoly({ type: "Point" })).not.toEqual([]); expect(validatePoly({ type: "Polygon", coordinates: [[[500, 0], [1, 1], [2, 2], [500, 0]]] })).not.toEqual([]);
  });
});
