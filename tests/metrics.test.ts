import { describe, it, expect, beforeAll } from "vitest";
import { resetDb, admin, dietitianId } from "./setup";
import { studyMetrics, exportCsv } from "../lib/services/metrics";
import { computeMetrics } from "../lib/domain";

const adminActor = async () => ({ role: "admin" as const, id: await dietitianId("admin@example.test") });

describe("metrics and export", () => {
  beforeAll(() => resetDb());

  it("computes behaviour outcomes from seeded synthetic data (hand-checked values)", async () => {
    const m = await studyMetrics(await adminActor(), "synthetic");
    expect(m.behaviour.enrolled).toBe(3); // P-0001, P-0002, P-0101 (P-0003 still invited)
    expect(m.behaviour.adoptionRate).toBe(1);
    expect(m.behaviour.opportunityDays).toBe(12);
    expect(m.behaviour.adherenceOnOpportunityDays).toBeCloseTo(9 / 12);
    expect(m.behaviour.noOpportunityDays).toBe(2);
    expect(m.behaviour.sustainedSelfReport[4]).toEqual({ answered: 1, sustained: 1, rate: 1 });
    expect(m.behaviour.repeatCycleRate).toBeCloseTo(1 / 3);
  });

  it("reports engagement separately, counting missed check-ins as data gaps", async () => {
    const m = await studyMetrics(await adminActor(), "synthetic");
    expect(m.engagement.checkinCompletion).toBeCloseTo(14 / 20);
    expect(m.engagement.dataGapDays).toBe(6);
    expect(m.engagement.barrierProfile).toEqual({ personal: 2, social: 1, environmental: 0 });
    expect(m.behaviour).not.toHaveProperty("checkinCompletion");
  });

  it("never mixes synthetic and real data", async () => {
    const real = await studyMetrics(await adminActor(), "real");
    expect(real.behaviour.enrolled).toBe(0);
    const csv = await exportCsv(await adminActor(), "checkins", "real");
    expect(csv.trim()).toBe("patient_code");
  });

  it("a dietitian's metrics are limited to their own patients by row-level security", async () => {
    const m = await studyMetrics({ role: "dietitian", id: await dietitianId("dietitian.b@example.test") }, "synthetic");
    expect(m.behaviour.enrolled).toBe(1);
  });

  it("export uses patient codes and dietitian codes, never internal ids", async () => {
    const csv = await exportCsv(await adminActor(), "plans", "synthetic");
    expect(csv.split("\n")[0]).toMatch(/^patient_code,/);
    expect(csv).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(csv).toMatch(/"D-0\d"/);
    expect(csv).toMatch(/"P-0001"/);
  });

  it("export is admin only and is recorded in the audit log", async () => {
    await expect(exportCsv({ role: "dietitian", id: await dietitianId("dietitian.a@example.test") }, "checkins", "synthetic")).rejects.toThrow(/admin only/);
    await exportCsv(await adminActor(), "checkins", "synthetic");
    const log = await admin("select action, entity from foodlg.audit_events where action like 'export:%' order by id desc limit 1");
    expect(log[0]).toEqual({ action: "export:synthetic", entity: "checkins" });
  });

  it("export neutralises spreadsheet formulas", async () => {
    await admin(`update foodlg.requests set reason = '=HYPERLINK("x")'`);
    const csv = await exportCsv(await adminActor(), "requests", "synthetic");
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it("no-opportunity days and gaps never count against adherence", () => {
    const m = computeMetrics({ patientIds: ["p"], today: "2026-10-07",
      cycles: [{ id: "c", patient_id: "p", start_date: "2026-10-01" }],
      checkins: [
        { patient_id: "p", cycle_id: "c", day: "2026-10-01", outcome: "followed", barrier_level: null, barrier_id: null },
        { patient_id: "p", cycle_id: "c", day: "2026-10-02", outcome: "no_opportunity", barrier_level: null, barrier_id: null }],
      followups: [] });
    expect(m.behaviour.adherenceOnOpportunityDays).toBe(1);
    expect(m.engagement.dataGapDays).toBe(5);
  });
});
