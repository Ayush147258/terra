// Local (approximate) metrics for live editing. Coordinates are EPSG:4326 [lon, lat]; all metric maths
// happens after projecting to a local tangent plane in metres. Exact values come from the backend on release.
export type Poly = { type: "Polygon"; coordinates: number[][][] };
const R = 6371008.8, RAD = Math.PI / 180;
type P = [number, number];
const proj = (ring: number[][], lon0: number, lat0: number): P[] =>
  ring.map(([lon, lat]) => [(lon - lon0) * Math.cos(lat0 * RAD) * R * RAD, (lat - lat0) * R * RAD]);
const shoelace = (r: P[]) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
const open = (r: P[]) => r.slice(0, -1);
function clip(subject: P[], clipper: P[]): P[] {  // Sutherland–Hodgman; clipper must be convex
  const ccw = shoelace(clipper) > 0, cl = ccw ? clipper : [...clipper].reverse();
  let out = subject;
  for (let i = 0; i < cl.length && out.length; i++) {
    const a = cl[i], b = cl[(i + 1) % cl.length], inside = (p: P) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const inp = out; out = [];
    inp.forEach((p, j) => {
      const q = inp[(j + 1) % inp.length], pi = inside(p), qi = inside(q);
      if (pi !== qi) { const d1 = [q[0] - p[0], q[1] - p[1]], d2 = [b[0] - a[0], b[1] - a[1]], t = ((a[0] - p[0]) * d2[1] - (a[1] - p[1]) * d2[0]) / (d1[0] * d2[1] - d1[1] * d2[0]); out.push([p[0] + t * d1[0], p[1] + t * d1[1]]); }
      if (qi) out.push(q);
    });
  }
  return out;
}
const dPS = (p: P, a: P, b: P) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
const dense = (r: P[], step = 0.25) => r.slice(0, -1).flatMap((a, i) => { const b = r[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); return Array.from({ length: n }, (_, k): P => [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); });
const directed = (a: P[], b: P[]) => Math.max(...dense(a).map(p => Math.min(...b.slice(0, -1).map((s, i) => dPS(p, s, b[i + 1])))));
export interface LiveMetrics { candidateArea: number; recordedArea: number; areaDiff: number; areaDiffPct: number; overlapPct: number; symDiff: number; deviation: number }
export function liveMetrics(rec: Poly, cand: Poly): LiveMetrics {
  const [lon0, lat0] = rec.coordinates[0][0], r = proj(rec.coordinates[0], lon0, lat0), c = proj(cand.coordinates[0], lon0, lat0);
  const ra = Math.abs(shoelace(r)), ca = Math.abs(shoelace(c)), inter = Math.abs(shoelace(clip(open(c), open(r))));
  return { candidateArea: ca, recordedArea: ra, areaDiff: ca - ra, areaDiffPct: (ca - ra) / ra * 100, overlapPct: inter / ra * 100,
    symDiff: ca + ra - 2 * inter, deviation: Math.max(directed(r, c), directed(c, r)) };
}
const orient = (a: P, b: P, c: P) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const cross = (a: P, b: P, c: P, d: P) => orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
/** Returns human-readable problems; empty array = valid. */
export function validatePoly(g: any): string[] {
  if (!g || g.type !== "Polygon") return ["Expected a Polygon"];
  const ring: number[][] = g.coordinates?.[0];
  if (!ring || ring.length < 4) return ["Polygon needs at least 3 distinct vertices"];
  if (ring.some(p => p.length < 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) return ["Coordinates are not valid EPSG:4326 [lon, lat]"];
  const p = proj(ring, ring[0][0], ring[0][1]), n = p.length - 1, out: string[] = [];
  if (Math.abs(shoelace(p)) < 0.01) out.push("Polygon has zero area");
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) if (!(i === 0 && j === n - 1) && cross(p[i], p[i + 1], p[j], p[j + 1])) { out.push("Self-intersection: edges cross"); return out; }
  return out;
}
