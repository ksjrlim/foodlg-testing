import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, admin, idOf } from "./setup";
import * as svc from "../lib/services/patient";
import { adherence } from "../lib/domain";
import { today } from "../lib/db";

const patient = async (code: string) => ({ role: "patient" as const, id: await idOf(code) });

describe("patient workflow", () => {
  beforeEach(() => resetDb());

  it("loads the mid-cycle patient ready to check in, with adherence on opportunity days only", async () => {
    const s = await svc.loadPatientState(await patient("P-0001"));
    expect(s.phase).toBe("checkin");
    expect(s.option?.id).toBe("OPT-KOPI-O-KOSONG");
    const a = adherence(s.checkins);
    expect(a).toMatchObject({ followed: 1, notFollowed: 2, noOpportunity: 1, opportunity: 3 });
  });

  it("a no-opportunity day asks no barrier question and is excluded from adherence", async () => {
    const p = await patient("P-0001");
    await svc.recordCheckin(p, { outcome: "no_opportunity", context: "family" });
    const s = await svc.loadPatientState(p);
    expect(s.phase).toBe("done_today");
    const k = s.checkins.find(c => c.day === today())!;
    expect(k.outcome).toBe("no_opportunity");
    expect(k.barrier_id).toBeNull();
    expect(k.context).toBeNull();
    expect(adherence(s.checkins).opportunity).toBe(3);
  });

  it("taste barrier on a big step switches automatically to a pre-approved smaller step, starting tomorrow", async () => {
    const p = await patient("P-0001");
    const r = await svc.recordBarrier(p, { barrierId: "taste", accept: true, context: null });
    expect(r.permission).toBe("automatic");
    const s = await svc.loadPatientState(p);
    expect(s.option?.id).toBe("OPT-KOPI-SIUDAI");
    expect(s.phase).toBe("starts_tomorrow");
  });

  it("a switch to an option that is not pre-approved becomes a request and changes nothing", async () => {
    const p = await patient("P-0002"); // teh plan: TEH-SIUDAI, TEH-O-KOSONG; current TEH-O-KOSONG
    const before = await svc.loadPatientState(p);
    const r = await svc.recordBarrier(p, { barrierId: "stall_cant", accept: true, context: null });
    expect(r.permission).toBe("requested");
    const after = await svc.loadPatientState(p);
    expect(after.option?.id).toBe(before.option?.id);
    expect(after.requests[0]).toMatchObject({ type: "switch_not_preapproved", status: "awaiting" });
    const plans = await admin("select preapproved_option_ids from foodlg.plans where patient_id = $1 and is_active", [p.id]);
    expect(plans[0].preapproved_option_ids).toEqual(["OPT-TEH-SIUDAI", "OPT-TEH-O-KOSONG"]);
  });

  it("an exception day always needs dietitian approval", async () => {
    const p = await patient("P-0002");
    const r = await svc.recordBarrier(p, { barrierId: "craving", accept: true, context: null });
    expect(r.resolution.action.kind).toBe("request");
    expect(r.permission).toBe("requested");
  });

  it("declining the suggestion records the barrier with no action applied", async () => {
    const p = await patient("P-0001");
    const r = await svc.recordBarrier(p, { barrierId: "ordered_for", accept: false, context: "colleagues" });
    expect(r.permission).toBeNull();
    const s = await svc.loadPatientState(p);
    expect(s.checkins.find(c => c.day === today())).toMatchObject({ outcome: "not_followed", barrier_level: "social", context: "colleagues" });
  });

  it("the database refuses a chosen option that is not pre-approved", async () => {
    const p = await patient("P-0001");
    await svc.closeCycle(p, "next_change");
    await expect(svc.chooseChange(p, { chosen: "OPT-TEH-SIUDAI", answers: {} })).rejects.toThrow(/not pre-approved/);
  });

  it("a patient cannot change their own plan or status", async () => {
    const p = await patient("P-0001");
    const { withActor } = await import("../lib/db");
    await expect(withActor(p, db => db.query("update foodlg.plans set goal = 'x'"))).rejects.toThrow(/only a dietitian/);
    await expect(withActor(p, db => db.query("update foodlg.patients set status = 'withdrawn' where id = $1", [p.id]))).rejects.toThrow(/reminder time/);
  });

  it("a patient sees only their own records", async () => {
    const p = await patient("P-0001");
    const { withActor } = await import("../lib/db");
    const codes = await withActor(p, db => db.query("select code from foodlg.patients")).then(r => r.rows.map(x => x.code));
    expect(codes).toEqual(["P-0001"]);
    const others = await withActor(p, db => db.query("select count(*)::int n from foodlg.checkins where patient_id <> $1", [p.id]));
    expect(others.rows[0].n).toBe(0);
  });

  it("closing a cycle with 'continue' starts another week of the same change", async () => {
    const p = await patient("P-0001");
    await svc.closeCycle(p, "continue");
    const s = await svc.loadPatientState(p);
    expect(s.cycleCount).toBe(2);
    expect(s.option?.id).toBe("OPT-KOPI-O-KOSONG");
  });
});
