import { useEffect, useReducer, useRef, useState } from "react";
import maplibregl, { Map } from "maplibre-gl";
import { Recon, runReconciliation, layerVisibility, hasDiscrepancy, signed, STATUS_LABEL, STATUS_SHORT } from "./recon";
import { saveCandidate, evaluateCandidate, getSaved, getAudit, Exact, Audit } from "./recon";
import { editReducer, initialEdit, canSave, problems, vertexFeatures, isModifiedFromOriginal } from "./edit";
import { liveMetrics } from "./geo";
import { Review, RState, STATE_LABEL, controlsFor, canReject, statusDetail, historyLines, getReview, submitReview, approve as approveApi, reject as rejectApi, getVerified, runValidation, latestValidation, validationHeadline, verifiedNote, CHECK_MARK, checkLabel } from "./review";

type Props = Record<string, any>;
type FC = { features: { properties: Props; geometry: any }[] };
const LAYERS: { key: string; label: string; ids: string[]; color: string }[] = [
  { key: "imagery", label: "Imagery (synthetic backdrop)", ids: ["imagery"], color: "#cfd8cc" },
  { key: "recorded", label: "Recorded Geometry", ids: ["rec-fill", "rec-line"], color: "#1f4e9c" },
  { key: "observed", label: "Observed Geometry", ids: ["obs-fill", "obs-line", "obx-line"], color: "#d98a1c" },
  { key: "candidate", label: "Candidate Geometry", ids: ["cand-fill", "cand-line", "cnd-fill", "cnd-line"], color: "#7a4fd1" },
  { key: "discrepancy", label: "Discrepancy", ids: ["dis-fill", "dis-line", "rdis-fill", "rdis-line"], color: "#d1342f" },
  { key: "verified", label: "Verified Geometry", ids: ["ver-fill", "ver-line"], color: "#1c8a55" },
];
const empty = { type: "FeatureCollection", features: [] };

export default function App() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const [vis, setVis] = useState<Record<string, boolean>>(Object.fromEntries(LAYERS.map(l => [l.key, true])));
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [sel, setSel] = useState<{ p: Props; obs: Props[] } | null>(null);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<Recon | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Record<string, Recon>>({});
  const [ids, setIds] = useState<string[]>([]);
  const doneRef = useRef<Record<string, Recon>>({});
  const select = useRef<(id: string) => void>(() => {});
  const [cand, dispatch] = useReducer(editReducer, initialEdit);
  const candRef = useRef(cand); candRef.current = cand;
  const idRef = useRef(""); idRef.current = sel?.p.parcel_id ?? "";
  const drag = useRef(-1);
  const [exact, setExact] = useState<Exact | null>(null);
  const [saveErr, setSaveErr] = useState(""); const [audit, setAudit] = useState<Audit[]>([]);
  const [review, setReview] = useState<Review | null>(null); const [note, setNote] = useState(""); const [actBusy, setActBusy] = useState(false); const [verifiedCount, setVerifiedCount] = useState(0); const [validating, setValidating] = useState(false);
  const [flash, setFlash] = useState(""); const [active, setActive] = useState(-1);
  const obsRef = useRef<FC>({ features: [] });

  useEffect(() => {
    let dead = false;
    Promise.all(["recorded", "observed", "candidates"].map(n => fetch(`/data/${n}.geojson`).then(r => r.json())))
      .then(([rec, obs, cand]) => {
        if (dead || !el.current) return;
        obsRef.current = obs;
        setIds(rec.features.map((f: any) => f.properties.parcel_id));
        setCounts({ recorded: rec.features.length, observed: obs.features.length,
          flagged: obs.features.filter((f: any) => f.properties.flagged).length,
          verified: 0 });
        const m = new maplibregl.Map({ container: el.current, attributionControl: false, style: {
          version: 8, sources: {}, layers: [{ id: "imagery", type: "background", paint: { "background-color": "#dfe6dc" } }] } });
        map.current = m;
        m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
        m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
        m.on("load", () => {
          const add = (id: string, data: any, color: string, fillOp: number, w: number, filter?: any) => {
            if (!m.getSource(id)) m.addSource(id, { type: "geojson", data });
            const f = filter ? { filter } : {};
            m.addLayer({ id: `${id}-fill`, type: "fill", source: id, paint: { "fill-color": color, "fill-opacity": fillOp }, ...f });
            m.addLayer({ id: `${id}-line`, type: "line", source: id, paint: { "line-color": color, "line-width": w }, ...f });
          };
          add("rec", rec, "#1f4e9c", 0.12, 1.6);
          add("obs", obs, "#d98a1c", 0.35, 1.2);
          add("cand", cand, "#7a4fd1", 0.3, 1.6);
          m.addSource("dis-src", { type: "geojson", data: obs });
          m.addLayer({ id: "dis-fill", type: "fill", source: "dis-src", filter: ["==", ["get", "flagged"], true], paint: { "fill-color": "#d1342f", "fill-opacity": 0.35 } });
          m.addLayer({ id: "dis-line", type: "line", source: "dis-src", filter: ["==", ["get", "flagged"], true], paint: { "line-color": "#d1342f", "line-width": 2.4 } });
          add("ver", empty, "#1c8a55", 0.22, 3.6);
          m.addLayer({ id: "sel-line", type: "line", source: "rec", filter: ["==", ["get", "parcel_id"], ""], paint: { "line-color": "#0b1f3f", "line-width": 4 } });
          const fc = (g: any) => ({ type: "FeatureCollection", features: g ? [{ type: "Feature", properties: {}, geometry: g }] : [] });
          (["obx", "cnd", "rdis"] as const).forEach(k => m.addSource(k, { type: "geojson", data: fc(null) as any }));
          m.addLayer({ id: "rdis-fill", type: "fill", source: "rdis", paint: { "fill-color": "#d1342f", "fill-opacity": 0.55 } });
          m.addLayer({ id: "rdis-line", type: "line", source: "rdis", paint: { "line-color": "#8f1d1a", "line-width": 1, "line-dasharray": [1, 1] } });
          m.addLayer({ id: "obx-line", type: "line", source: "obx", paint: { "line-color": "#d98a1c", "line-width": 2.6 } });
          m.addLayer({ id: "cnd-line", type: "line", source: "cnd", paint: { "line-color": "#7a4fd1", "line-width": 2.4, "line-dasharray": [3, 2] } });
          m.addLayer({ id: "cnd-fill", type: "fill", source: "cnd", paint: { "fill-color": "#7a4fd1", "fill-opacity": 0.1 } });
          (m as any).__fc = fc;
          m.addSource("ovl", { type: "geojson", data: fc(null) as any });
          m.addLayer({ id: "ovl-fill", type: "fill", source: "ovl", paint: { "fill-color": "#d1342f", "fill-opacity": 0.7 } });
          m.addLayer({ id: "ovl-line", type: "line", source: "ovl", paint: { "line-color": "#5c0f0d", "line-width": 2 } });
          refreshVerified();
          (["cbf", "edv"] as const).forEach(k => m.addSource(k, { type: "geojson", data: fc(null) as any }));
          m.addLayer({ id: "cbf-line", type: "line", source: "cbf", paint: { "line-color": "#7d8798", "line-width": 1.6, "line-dasharray": [1, 2] } });
          m.addLayer({ id: "edv-pt", type: "circle", source: "edv", paint: { "circle-radius": ["case", ["get", "active"], 9, 6], "circle-color": ["case", ["get", "active"], "#7a4fd1", "#ffffff"], "circle-stroke-color": "#7a4fd1", "circle-stroke-width": 2.5 } });
          const xs: number[] = [], ys: number[] = [];
          rec.features.forEach((f: any) => f.geometry.coordinates[0].forEach(([x, y]: number[]) => { xs.push(x); ys.push(y); }));
          m.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 60, animate: false });
          m.on("click", e => {
            const hit = m.queryRenderedFeatures(e.point, { layers: ["rec-fill"] })[0];
            if (candRef.current.editing) return;
            select.current(hit ? hit.properties!.parcel_id : "");
          });
          select.current = (id: string) => {
            m.setFilter("sel-line", ["==", ["get", "parcel_id"], id]);
            const f = rec.features.find((x: any) => x.properties.parcel_id === id);
            setSel(f ? { p: f.properties, obs: obsRef.current.features.filter(o => o.properties.parcel_id === id).map(o => o.properties) } : null);
            show(doneRef.current[id] ?? null);
          };
          const show = (r: Recon | null) => {
            setResult(r); const fc2 = (m as any).__fc;
            (m.getSource("obx") as any).setData(fc2(r?.observed_geometry));
            (m.getSource("rdis") as any).setData(fc2(r?.discrepancy_geometry));
          };
          (m as any).__show = show;
          m.on("mousemove", "rec-fill", () => (m.getCanvas().style.cursor = "pointer"));
          m.on("mouseleave", "rec-fill", () => (m.getCanvas().style.cursor = ""));
          m.on("mouseenter", "edv-pt", () => { if (candRef.current.editing) m.getCanvas().style.cursor = "grab"; });
          m.on("mousedown", "edv-pt", e => { if (!candRef.current.editing) return; e.preventDefault(); drag.current = e.features![0].properties!.i; setActive(drag.current); dispatch({ type: "beginDrag" }); m.dragPan.disable(); });
          m.on("mousemove", e => { if (drag.current >= 0) dispatch({ type: "move", index: drag.current, lng: e.lngLat.lng, lat: e.lngLat.lat }); });
          m.on("mouseup", () => { if (drag.current < 0) return; drag.current = -1; setActive(-1); m.dragPan.enable(); release(); });
        });
      }).catch(e => setErr(String(e)));
    return () => { dead = true; map.current?.remove(); };
  }, []);

  const toggle = (k: string, ids: string[]) => {
    const on = !vis[k]; setVis(v => ({ ...v, [k]: on }));
  };
  const run = async () => {
    if (!sel) return; setBusy(true); setErr("");
    try {
      const r = await runReconciliation(sel.p.parcel_id);
      doneRef.current = { ...doneRef.current, [r.parcel_id]: r }; setDone(doneRef.current); (map.current as any).__show(r);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { const v = layerVisibility(vis); Object.entries(v).forEach(([id, val]) => map.current?.getLayer(id) && map.current.setLayoutProperty(id, "visibility", val as string)); }, [vis, result]);
  const release = async () => { const c = candRef.current; if (!c.current) return;
    try { setExact(await evaluateCandidate(idRef.current, c.current)); setSaveErr(""); } catch (e) { setExact(null); setSaveErr((e as Error).message); } };
  const save = async () => { const c = candRef.current; if (!canSave(c)) return;
    try { const r = await saveCandidate(idRef.current, c.current); dispatch({ type: "saved", geometry: r.geometry, version: r.candidate_version });
      setSaveErr(""); setExact(null); setFlash(`${r.status} (candidate v${r.candidate_version})`); getAudit().then(setAudit).catch(() => {}); refreshReview(); }
    catch (e) { setSaveErr((e as Error).message); } };
  useEffect(() => { if (!result) { dispatch({ type: "clear" }); setReview(null); return; } setExact(null); setSaveErr(""); setFlash(""); let dead = false;
    getSaved(result.parcel_id).then(sv => { if (dead) return; dispatch({ type: "load", geometry: sv ? sv.geometry : result.candidate_geometry, base: result.candidate_geometry, version: sv?.candidate_version ?? 0 }); refreshReview(); refreshVerified(); }).catch(e => setErr((e as Error).message));
    return () => { dead = true; }; }, [result]);
  useEffect(() => { const m = map.current; try { if (!m || !m.getSource("cbf")) return; } catch { return; }
    const fc = (m as any).__fc;
    (m!.getSource("cnd") as any).setData(fc(cand.current)); (m!.getSource("edv") as any).setData(cand.editing ? vertexFeatures(cand.current, active) : fc(null));
    (m!.getSource("cbf") as any).setData(fc(isModifiedFromOriginal(cand) ? cand.base : null)); }, [cand, active]);
  useEffect(() => { getAudit().then(setAudit).catch(() => {}); }, []);
  const refreshReview = async () => { const id = idRef.current; try { setReview(id ? await getReview(id) : null); } catch { setReview(null); } };
  const refreshVerified = async () => { try { const v = await getVerified(); setVerifiedCount(v.features.length); const m = map.current; if (m && m.getSource("ver")) (m.getSource("ver") as any).setData(v); } catch { /* backend offline */ } };
  useEffect(() => { const m = map.current, lv = latestValidation(review);   // overlap geometry comes from PostGIS ST_Intersection
    try { if (m && m.getSource("ovl")) (m.getSource("ovl") as any).setData(lv && lv.status !== "VALID" && lv.overlap_geometry && lv.candidate_version === review?.latest_version ? lv.overlap_geometry : { type: "FeatureCollection", features: [] }); } catch { /* not ready */ } }, [review]);
  useEffect(() => { const m = map.current; try { if (m && m.getLayer("cnd-line")) m.setPaintProperty("cnd-line", "line-width", review?.state === "IN_REVIEW" ? 4.5 : 2.4); } catch { /* not ready */ } }, [review]);
  const doAct = async (fn: () => Promise<unknown>) => { setActBusy(true); setSaveErr(""); try { await fn(); setNote(""); await refreshReview(); await refreshVerified(); } catch (e) { setSaveErr((e as Error).message); } finally { setActBusy(false); } };
  const S = ({ l, v }: { l: string; v: string }) => <div className="kv"><span>{l}</span><b>{v}</b></div>;

  const validateNow = async () => { setValidating(true); try { await runValidation(pid(), candRef.current.version); } finally { setValidating(false); } };
  const st: RState = review?.state ?? "UNREVIEWED", acts = controlsFor(st, cand.editing), pid = () => idRef.current;
  const reviewUI = <div>
    <div className={"rstate " + st}>{STATE_LABEL[st]}</div><p className="note">{statusDetail(review)}</p>
    <div className="lock"><span>OBSERVED</span><b>REFERENCE</b></div>
    {st === "VERIFIED" && review?.verified && <div className="verified"><b>✓ HUMAN APPROVED</b><div>Verified geometry: available</div><div>Source: candidate v{review.verified.source_candidate_version}</div><div>Review: approved ({review.reviewer})</div></div>}
    <div className="btns">
      {acts.includes("edit") && <button onClick={() => { dispatch({ type: "start" }); setFlash(""); setExact(null); }}>Edit candidate</button>}
      {acts.includes("review") && <button className="run" disabled={actBusy} onClick={() => doAct(() => submitReview(pid(), cand.version))}>Review candidate</button>}
      {acts.includes("validate") && <button className="run" disabled={actBusy} onClick={() => doAct(validateNow)}>Run PostGIS validation</button>}
      {acts.includes("view") && <button onClick={() => setVis(v => ({ ...v, verified: true }))}>View verified</button>}</div>
    {acts.includes("approve") && <div><textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Review decision (note optional for approve; reason required to reject)" />
      <div className="btns"><button className="run ok" disabled={actBusy} onClick={() => doAct(async () => { await approveApi(pid(), cand.version, note); await validateNow(); })}>Approve</button>
        <button className="rej" disabled={actBusy || !canReject(note)} onClick={() => doAct(() => rejectApi(pid(), cand.version, note))}>Reject</button></div></div>}
  </div>;
  return (
    <div className="app">
      <header><div><strong>CREDNODE TERRA</strong><span className="sub">Offline Prototype</span></div>
        <span className="badge">DEMO / POC DATA — synthetic, not real cadastral records</span></header>
      <aside className="left"><h3>Layers</h3>
        {LAYERS.map(l => <label key={l.key} className="layer">
          <input type="checkbox" checked={vis[l.key]} onChange={() => toggle(l.key, l.ids)} />
          <i style={{ background: l.color }} />{l.label}</label>)}
        <h3 style={{ marginTop: 18 }}>Parcels</h3>
        <select value={sel?.p.parcel_id ?? ""} disabled={cand.editing} onChange={e => select.current(e.target.value)}><option value="">Select…</option>{ids.map(i => <option key={i}>{i}</option>)}</select>
        {Object.values(done).map(r => <div key={r.parcel_id} className="plist" onClick={() => select.current(r.parcel_id)}>{r.parcel_id}<span className={"pill " + r.discrepancy_status}>{STATUS_SHORT[r.discrepancy_status]}</span></div>)}
        <p className="note">Verified layer stays empty until human review is built.</p></aside>
      <main><div ref={el} className="map" />{err && <div className="err">Failed to load demo data: {err}</div>}</main>
      <aside className="right"><h3>Parcel reconciliation</h3>
        {!sel ? <><div className="tag">SELECT A PARCEL</div><p className="note">Click a recorded parcel to inspect its geometry.</p></> : <>
          <div className="tag">RECORDED PARCEL</div><h2>{sel.p.parcel_id}</h2>
          <S l="Area" v={`${sel.p.area_m2} m²`} /><S l="Status" v={sel.p.status} />
          <S l="Source" v={sel.p.source} /><S l="Geometry type" v={sel.p.geometry_type} />
          <button className="run" disabled={busy || cand.editing} onClick={run}>{busy ? "Reconciling…" : result ? "Re-run reconciliation" : "Run reconciliation"}</button>
          {err && <div className="errline">{err}</div>}
          {result && <div className="recon">
            <div className={"status " + result.discrepancy_status}>{STATUS_LABEL[result.discrepancy_status]}</div>
            <S l="Recorded area" v={`${result.recorded_area.toFixed(1)} m²`} /><S l="Observed area" v={`${result.observed_area.toFixed(1)} m²`} />
            <S l="Area difference" v={`${signed(result.area_difference, " m²")} (${signed(result.area_difference_percent, "%")})`} />
            <S l="Overlap" v={`${result.overlap_percent.toFixed(1)}%`} /><S l="Symmetric difference" v={`${result.symmetric_difference_area.toFixed(1)} m²`} />
            <S l="Boundary deviation" v={`${result.boundary_deviation.toFixed(1)} m`} />
            <h3>Why flagged</h3>{result.discrepancy_reasons.length ? <ul>{result.discrepancy_reasons.map(r => <li key={r}>{r}</li>)}</ul> : <p className="note">No tolerance exceeded.</p>}
            <p className="note">Candidate geometry is a proposal for HUMAN REVIEW, not verified. Thresholds are demo/POC values, not survey standards.</p>
            <div className="key"><span className="k-rec">Recorded (solid blue)</span><span className="k-obs">Observed (solid orange)</span><span className="k-cnd">Candidate (dashed purple)</span>{latestValidation(review)?.overlap_geometry && latestValidation(review)?.status !== "VALID" && <span className="k-dis">Neighbour overlap (PostGIS intersection)</span>}{st === "VERIFIED" && <span className="k-ver">Verified (thick solid green)</span>}{hasDiscrepancy(result) && <span className="k-dis">Discrepancy area (red fill)</span>}</div></div>}
          {result && cand.current && (() => {
            const lm = liveMetrics(result.recorded_geometry, cand.current), pr = problems(cand), mod = isModifiedFromOriginal(cand), lv = latestValidation(review);
            const a = exact?.candidate_area ?? lm.candidateArea, d = exact?.area_difference ?? lm.areaDiff, dp = exact?.area_difference_percent ?? lm.areaDiffPct;
            return <div className="edit"><h3>Human review</h3>
              <div className="lock"><span>RECORDED</span><b>{result.recorded_area.toFixed(1)} m² · LOCKED</b></div>
              <div className="lock"><span>CANDIDATE {cand.version ? `v${cand.version}` : "(engine proposal)"}</span><b>{cand.editing ? "EDITING" : "EDITABLE"}{mod && <em className="mod"> MODIFIED</em>}</b></div>
              {!cand.editing ? reviewUI
                : <div className="btns"><button className="run" disabled={!canSave(cand)} onClick={save}>Save candidate</button>
                  <button disabled={!cand.history.length} onClick={() => { dispatch({ type: "undo" }); setExact(null); }}>Undo</button>
                  <button onClick={() => { dispatch({ type: "cancel" }); setExact(null); setSaveErr(""); }}>Cancel edit</button></div>}
              {cand.editing && <p className="note">Drag a purple vertex. Recorded and observed geometry stay locked.</p>}
              <h3>After edit {exact ? "(exact, backend)" : "(live, approximate)"}</h3>
              <S l="Candidate area" v={`${a.toFixed(1)} m²`} /><S l="Difference vs recorded" v={`${signed(d, " m²")} (${signed(dp, "%")})`} />
              <S l="Overlap" v={`${(exact?.overlap_percent ?? lm.overlapPct).toFixed(1)}%`} /><S l="Symmetric difference" v={`${(exact?.symmetric_difference_area ?? lm.symDiff).toFixed(1)} m²`} />
              <S l="Boundary deviation" v={`${(exact?.boundary_deviation ?? lm.deviation).toFixed(1)} m`} />
              <div className={pr.length ? "errline" : "okline"}>{pr.length ? `⚠ CANDIDATE GEOMETRY INVALID — ${pr[0]}` : "✓ Valid candidate geometry"}</div>
              {saveErr && <div className="errline">{saveErr}</div>}
              {flash && !cand.editing && <div className="okline">{flash}</div>}
              {(validating || lv) && <div className="valid"><h3>PostGIS validation</h3><div className={"vhead " + (validating ? "RUN" : lv?.status)}>{validationHeadline(lv, validating)}</div>
                {!validating && lv && <><p className="note">Candidate v{lv.candidate_version}</p><ul className="checks">{lv.checks.map(c => <li key={c.check} className={c.status}>{CHECK_MARK[c.status]} {c.message}</li>)}</ul>
                  {lv.errors.length > 0 && <p className="errline">Reason: {lv.errors.join("; ")}</p>}<div className="vnote">{verifiedNote(lv)}</div>
                  <details><summary>Validation details</summary>{lv.checks.map(c => <div className="kv" key={c.check}><span>{checkLabel(c.check)}</span><b>{c.status}</b></div>)}</details></>}</div>}
              {review && review.history.length > 0 && <><h3>Review history</h3>{historyLines(review.history).map((l, n) => <div className="hist" key={n}><b>{l.time}</b> {l.text}{l.detail && <div className="note">{l.detail}</div>}</div>)}</>}
            </div>; })()}
          <h3>Observed features</h3>
          {sel.obs.length === 0 ? <p className="note">None linked.</p> : sel.obs.map(o => (
            <div key={o.feature_id} className={"obs" + (o.flagged ? " flag" : "")}>
              <b>{o.feature_id}</b> {o.kind}<br />{o.area_m2} m² · {Math.round(o.outside_ratio * 100)}% outside parcel
              {o.flagged && <em> — flagged</em>}</div>))}</>}
      </aside>
      <footer>{counts ? <>
        <span><b>{counts.recorded}</b> Recorded</span><span><b>{counts.observed}</b> Observed</span>
        <span className="red"><b>{counts.flagged}</b> Flagged</span><span><b>{verifiedCount}</b> Verified</span></> : "Loading…"}
        <span className="right-note">Candidate geometry: 0 · reconciliation not yet implemented</span></footer>
    </div>);
}
