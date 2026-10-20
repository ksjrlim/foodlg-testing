import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, admin, idOf, dietitianId } from "./setup";
import * as d from "../lib/services/dietitian";
import * as p from "../lib/services/patient";
import { flagsFor } from "../lib/domain";

const dietitian = async (email: string) => ({ role: "dietitian" as const, id: await dietitianId(email) });

describe("dietitian workflow", () => {
  beforeEach(() => resetDb());

  it("each dietitian sees only their own patients", async () => {
    const A = await d.listPatients(await dietitian("dietitian.a@example.test"));
    const B = await d.listPatients(await dietitian("dietitian.b@example.test"));
    expect(A.map(x => x.code)).toEqual(["P-0001", "P-0002", "P-0003"]);
    expect(B.map(x => x.code)).toEqual(["P-0101"]);
  });

  it("another dietitian's patient summary returns nothing", async () => {
    const s = await d.patientSummary(await dietitian("dietitian.b@example.test"), await idOf("P-0001"));
    expect(s).toBeNull();
  });

  it("a dietitian cannot decide another dietitian's request", async () => {
    const req = (await admin("select id from foodlg.requests limit 1"))[0].id;
    await expect(d.decideRequest(await dietitian("dietitian.b@example.test"), req, "approved")).rejects.toThrow(/not found/);
  });

  it("summary flags the awaiting request and shows a taste-based discussion point", async () => {
    const s = (await d.patientSummary(await dietitian("dietitian.a@example.test"), await idOf("P-0001")))!;
    expect(s.flags.some(f => f.kind === "request")).toBe(true);
    expect(s.topBarrier).toMatchObject({ id: "taste", n: 2 });
    expect(s.discussion).toMatch(/Taste came up 2×/);
    expect(s.cycleAdherence).toMatchObject({ followed: 1, opportunity: 3, noOpportunity: 1 });
  });

  it("missed check-ins are flagged as a data gap, never as non-adherence", () => {
    const f = flagsFor({ checkins: [{ day: "2026-10-01", outcome: "followed" }], cycleStart: "2026-10-01", awaitingRequests: 0, today: "2026-10-05" });
    expect(f).toEqual([{ kind: "data_gap", text: expect.stringMatching(/data gap, not a sign the goal was missed/) }]);
    expect(f.some(x => x.kind === "consecutive_usual")).toBe(false);
  });

  it("three usual-drink days in a row raise a flag; no-opportunity days don't break the run", () => {
    const f = flagsFor({ today: "2026-10-04", cycleStart: "2026-10-01", awaitingRequests: 0, checkins: [
      { day: "2026-10-01", outcome: "not_followed" }, { day: "2026-10-02", outcome: "no_opportunity" },
      { day: "2026-10-03", outcome: "not_followed" }, { day: "2026-10-04", outcome: "not_followed" }] });
    expect(f.some(x => x.kind === "consecutive_usual")).toBe(true);
  });

  it("enrolment creates an invited patient and a version-1 plan with the pre-approved options", async () => {
    const A = await dietitian("dietitian.a@example.test");
    const r = await d.enrolPatient(A, { code: "p-0004", preapproved: ["OPT-KOPI-SIUDAI", "NOT-AN-OPTION"], reviewDate: null, inclusionConfirmed: true });
    expect(r.code).toBe("P-0004");
    expect(r.invitePath).toMatch(/^\/join\/[A-Za-z0-9_-]{20,}$/);
    const rows = await admin("select p.status, pl.version, pl.preapproved_option_ids, pl.approved_by from foodlg.patients p join foodlg.plans pl on pl.patient_id = p.id where p.code = 'P-0004'");
    expect(rows[0]).toMatchObject({ status: "invited", version: 1, preapproved_option_ids: ["OPT-KOPI-SIUDAI"], approved_by: A.id });
  });

  it("enrolment requires inclusion confirmation and at least one valid option", async () => {
    const A = await dietitian("dietitian.a@example.test");
    await expect(d.enrolPatient(A, { code: "P-0005", preapproved: ["OPT-KOPI-SIUDAI"], reviewDate: null, inclusionConfirmed: false })).rejects.toThrow(/inclusion/);
    await expect(d.enrolPatient(A, { code: "P-0005", preapproved: [], reviewDate: null, inclusionConfirmed: true })).rejects.toThrow(/at least one/);
  });

  it("approving a not-pre-approved switch adds the option as a new plan version, recorded with the approver", async () => {
    const pat = { role: "patient" as const, id: await idOf("P-0002") };
    await p.recordBarrier(pat, { barrierId: "stall_cant", accept: true, context: null });
    const req = (await admin("select id from foodlg.requests where patient_id = $1 and status = 'awaiting'", [pat.id]))[0].id;
    const A = await dietitian("dietitian.a@example.test");
    await d.decideRequest(A, req, "approved");
    const plans = await admin("select version, is_active, preapproved_option_ids, approved_by from foodlg.plans where patient_id = $1 order by version", [pat.id]);
    expect(plans).toHaveLength(2);
    expect(plans[1]).toMatchObject({ version: 2, is_active: true, approved_by: A.id });
    expect(plans[1].preapproved_option_ids).toContain("OPT-PLAIN-WATER");
    const r = (await admin("select status, decided_by from foodlg.requests where id = $1", [req]))[0];
    expect(r).toMatchObject({ status: "approved", decided_by: A.id });
  });

  it("holding a request changes nothing in the plan", async () => {
    const A = await dietitian("dietitian.a@example.test");
    const pid = await idOf("P-0001");
    const req = (await admin("select id from foodlg.requests where patient_id = $1", [pid]))[0].id;
    await d.decideRequest(A, req, "held");
    const plans = await admin("select count(*)::int n from foodlg.plans where patient_id = $1", [pid]);
    expect(plans[0].n).toBe(1);
  });

  it("a patient cannot decide their own request", async () => {
    const pid = await idOf("P-0001");
    const { withActor } = await import("../lib/db");
    await expect(withActor({ role: "patient", id: pid }, db => db.query("update foodlg.requests set status = 'approved' where patient_id = $1", [pid]))).rejects.toThrow(/only a dietitian/);
  });

  it("existing cycles still close after the plan gets a new version", async () => {
    const A = await dietitian("dietitian.a@example.test");
    const pid = await idOf("P-0001");
    await d.updatePreapproved(A, pid, ["OPT-KOPI-SIUDAI", "OPT-KOPI-O-KOSONG"]);
    await p.closeCycle({ role: "patient", id: pid }, "continue");
    const s = await p.loadPatientState({ role: "patient", id: pid });
    expect(s.cycleCount).toBe(2);
  });
});
