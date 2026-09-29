import { describe, it, expect, vi } from "vitest";
import { runReconciliation, layerVisibility, hasDiscrepancy, signed, STATUS_SHORT, Recon } from "./recon";
const R = { parcel_id: "DEMO-018", discrepancy_status: "MAJOR_DISCREPANCY", discrepancy_geometry: { type: "Polygon" }, area_difference_percent: 25.4 } as unknown as Recon;
const ok = (b: unknown) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => b }) as unknown as typeof fetch;
describe("reconciliation client", () => {
  it("POSTs to the parcel endpoint and returns metrics", async () => {
    const f = ok(R); const r = await runReconciliation("DEMO-018", f);
    expect(f).toHaveBeenCalledWith("/api/reconciliation/DEMO-018", { method: "POST" });
    expect(r.area_difference_percent).toBe(25.4);
  });
  it("surfaces backend error detail (404 parcel not found)", async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ detail: "Parcel X not found" }) }) as unknown as typeof fetch;
    await expect(runReconciliation("X", f)).rejects.toThrow("Parcel X not found");
  });
});
describe("display state", () => {
  it("layer toggles map to real map layer ids", () => {
    const v = layerVisibility({ imagery: true, recorded: true, observed: false, candidate: true, discrepancy: false, verified: true });
    expect(v["obx-line"]).toBe("none"); expect(v["rdis-fill"]).toBe("none"); expect(v["cnd-line"]).toBe("visible"); expect(v["rec-fill"]).toBe("visible");
  });
  it("discrepancy state depends on result", () => {
    expect(hasDiscrepancy(R)).toBe(true); expect(hasDiscrepancy(null)).toBe(false);
    expect(hasDiscrepancy({ ...R, discrepancy_status: "MATCH" })).toBe(false);
  });
  it("formats signed values and statuses", () => { expect(signed(21.6, " m²")).toBe("+21.6 m²"); expect(signed(-3.2, "%")).toBe("-3.2%"); expect(STATUS_SHORT.MINOR_DISCREPANCY).toBe("MINOR"); });
});
