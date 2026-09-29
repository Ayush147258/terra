import { Poly, validatePoly } from "./geo";
export interface EditState {
  current: Poly | null;   // geometry shown on the map (moves live while dragging)
  saved: Poly | null;     // last persisted / loaded candidate
  base: Poly | null;      // original engine candidate (BEFORE)
  snapshot: Poly | null;  // candidate exactly as it was when edit mode started (Cancel target)
  history: Poly[]; editing: boolean; version: number; }
export const initialEdit: EditState = { current: null, saved: null, base: null, snapshot: null, history: [], editing: false, version: 0 };
export type EditAction =
  | { type: "load"; geometry: Poly; base: Poly; version: number } | { type: "clear" } | { type: "start" }
  | { type: "beginDrag" } | { type: "move"; index: number; lng: number; lat: number }
  | { type: "undo" } | { type: "cancel" } | { type: "saved"; geometry: Poly; version: number };
const clone = (p: Poly): Poly => JSON.parse(JSON.stringify(p));
export function editReducer(s: EditState, a: EditAction): EditState {
  switch (a.type) {
    case "load": return { ...initialEdit, current: clone(a.geometry), saved: clone(a.geometry), base: clone(a.base), version: a.version };
    case "clear": return initialEdit;
    case "start": return s.current ? { ...s, editing: true, snapshot: clone(s.current), history: [] } : s;
    case "beginDrag": return s.editing && s.current ? { ...s, history: [...s.history, clone(s.current)] } : s;
    case "move": {
      if (!s.editing || !s.current) return s;                       // no edits outside edit mode
      const ring = s.current.coordinates[0].map(p => [...p]), last = ring.length - 1;
      if (a.index < 0 || a.index >= last) return s;
      ring[a.index] = [a.lng, a.lat]; if (a.index === 0) ring[last] = [a.lng, a.lat];
      return { ...s, current: { type: "Polygon", coordinates: [ring, ...s.current.coordinates.slice(1)] } };
    }
    case "undo": { if (!s.editing || !s.history.length) return s; const h = [...s.history]; return { ...s, current: h.pop()!, history: h }; }
    case "cancel": return s.editing ? { ...s, current: s.snapshot ? clone(s.snapshot) : s.current, editing: false, history: [], snapshot: null } : s;
    case "saved": return { ...s, current: clone(a.geometry), saved: clone(a.geometry), editing: false, history: [], snapshot: null, version: a.version };
  }
}
export const problems = (s: EditState) => (s.current ? validatePoly(s.current) : ["No candidate"]);
export const isChanged = (s: EditState) => !!s.current && JSON.stringify(s.current) !== JSON.stringify(s.snapshot ?? s.saved);
export const canSave = (s: EditState) => s.editing && isChanged(s) && problems(s).length === 0;
export const isModifiedFromOriginal = (s: EditState) => !!s.current && !!s.base && JSON.stringify(s.current) !== JSON.stringify(s.base);
export const vertexFeatures = (p: Poly | null, active = -1) => ({ type: "FeatureCollection" as const,
  features: (p ? p.coordinates[0].slice(0, -1) : []).map((c, i) => ({ type: "Feature" as const, properties: { i, active: i === active }, geometry: { type: "Point" as const, coordinates: c } })) });
