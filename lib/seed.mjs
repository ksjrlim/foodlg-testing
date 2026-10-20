// Synthetic seed data, shared by the local reset script and the hosted setup route.
// SYNTHETIC ONLY. Every write goes through the same role, row-level security and guards as the app.
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";

export const DEMO_PASSWORD = "demo-password-1";
export const DEMO_PASSCODE = "246810";

/** db: a connected pg client on a database where the foodlg schema has just been created. */
export async function seed(db) {
  const sgToday = new Date(Date.now() + 8 * 3600e3);
  const day = n => new Date(sgToday.getTime() + n * 864e5).toISOString().slice(0, 10);
  const as = async (role, id, sql, params) => {
    await db.query("begin");
    await db.query("set local role foodlg_app");
    await db.query("set local search_path = foodlg");
    await db.query("select set_config('app.actor_role',$1,true), set_config('app.actor_id',$2,true), set_config('app.rule_version','seed',true)", [role, id ?? ""]);
    const r = await db.query(sql, params);
    await db.query("commit");
    return r;
  };
  const hash = s => bcrypt.hashSync(s, 10);
  const tokenHash = t => createHash("sha256").update(t).digest("hex");


  const clinicA = (await as("admin", null, "insert into clinics(name, is_synthetic) values ('Synthetic Clinic A', true) returning id")).rows[0].id;
  const clinicB = (await as("admin", null, "insert into clinics(name, is_synthetic) values ('Synthetic Clinic B', true) returning id")).rows[0].id;
  const mk = (clinic, email, role = "dietitian") => as("admin", null,
    "insert into dietitians(clinic_id, role, email, password_hash) values ($1,$2,$3,$4) returning id", [clinic, role, email, hash(DEMO_PASSWORD)]).then(r => r.rows[0].id);
  const admin = await mk(clinicA, "admin@example.test", "admin");
  const dA = await mk(clinicA, "dietitian.a@example.test");
  const dB = await mk(clinicB, "dietitian.b@example.test");

  async function patient(code, dietitian, clinic, { invited = false } = {}) {
    const invite = `invite-${code.toLowerCase()}`;
    const r = await as("dietitian", dietitian,
      `insert into patients(code, clinic_id, dietitian_id, invite_token_hash, passcode_hash, consent_version, consent_at, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [code, clinic, dietitian, invited ? tokenHash(invite) : null, invited ? null : hash(DEMO_PASSCODE),
       invited ? null : "consent-v0.1-synthetic", invited ? null : new Date(), invited ? "invited" : "active"]);
    return { id: r.rows[0].id, invite };
  }
  async function plan(p, dietitian, pre, startOffset) {
    return (await as("dietitian", dietitian,
      `insert into plans(patient_id, version, goal, scope, preapproved_option_ids, start_date, review_date, approved_by)
       values ($1,1,'Reduce added sugar from drinks','drink_sugar',$2,$3,$4,$5) returning id`,
      [p.id, pre, day(startOffset), day(startOffset + 14), dietitian])).rows[0].id;
  }
  async function cycle(p, planId, option, startOffset) {
    await as("patient", p.id, "insert into choices(patient_id, plan_id, option_id, stall, control, taste, confidence, chosen) values ($1,$2,$3,'yes','yes',2,6,true)", [p.id, planId, option]);
    return (await as("patient", p.id, "insert into cycles(patient_id, plan_id, option_id, start_date, end_date) values ($1,$2,$3,$4,$5) returning id",
      [p.id, planId, option, day(startOffset), day(startOffset + 6)])).rows[0].id;
  }
  async function checkin(p, cycleId, offset, outcome, barrier = null, level = null, context = null, response = null, action = null, permission = null) {
    await as("patient", p.id, `insert into checkins(cycle_id, patient_id, day, outcome, context, barrier_id, barrier_level, response_id, action, permission)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [cycleId, p.id, day(offset), outcome, context, barrier, level, response, action, permission]);
  }

  // P-0001: Dietitian A, mid-cycle, recurring taste barrier, one request awaiting, recent data gap
  const p1 = await patient("P-0001", dA, clinicA);
  const plan1 = await plan(p1, dA, ["OPT-KOPI-SIUDAI", "OPT-KOPI-O-KOSONG", "OPT-PLAIN-WATER"], -6);
  const c1 = await cycle(p1, plan1, "OPT-KOPI-O-KOSONG", -5);
  await checkin(p1, c1, -5, "followed", null, null, "colleagues");
  await checkin(p1, c1, -4, "not_followed", "taste", "personal", "alone", "R-TASTE-SMALLER", "kept current change", null);
  await checkin(p1, c1, -3, "no_opportunity");
  await checkin(p1, c1, -2, "not_followed", "taste", "personal", "colleagues", "R-TASTE-SMALLER", "kept current change", null);
  await as("patient", p1.id, "insert into requests(patient_id, type, reason, detail) values ($1,'gentler_step','Patient finds the agreed sweetness reduction hard to accept; consider a gentler interim step.','{}')", [p1.id]);

  // P-0002: Dietitian A, finished one cycle, now in a second; week-4 follow-up answered
  const p2 = await patient("P-0002", dA, clinicA);
  const plan2 = await plan(p2, dA, ["OPT-TEH-SIUDAI", "OPT-TEH-O-KOSONG"], -30);
  const c2a = await cycle(p2, plan2, "OPT-TEH-SIUDAI", -29);
  for (const [o, out] of [[-29, "followed"], [-28, "followed"], [-27, "not_followed"], [-26, "followed"], [-25, "no_opportunity"], [-24, "followed"], [-23, "followed"]]) {
    if (out === "not_followed") await checkin(p2, c2a, o, out, "ordered_for", "social", "colleagues", "R-ORDERED-SCRIPT", "script", "automatic");
    else await checkin(p2, c2a, o, out);
  }
  await as("patient", p2.id, "update cycles set outcome='next_change' where id=$1", [c2a]);
  const c2b = await cycle(p2, plan2, "OPT-TEH-O-KOSONG", -2);
  await checkin(p2, c2b, -2, "followed");
  await checkin(p2, c2b, -1, "followed");
  await as("patient", p2.id, "insert into followups(patient_id, week, frequency) values ($1,4,'most')", [p2.id]);

  // P-0003: Dietitian A, invited, not yet joined
  const p3 = await patient("P-0003", dA, clinicA, { invited: true });
  await plan(p3, dA, ["OPT-KOPI-SIUDAI", "OPT-PLAIN-WATER"], 0);

  // P-0101: Dietitian B (different clinic) — used to prove isolation
  const p4 = await patient("P-0101", dB, clinicB);
  const plan4 = await plan(p4, dB, ["OPT-KOPI-SIUDAI"], -3);
  const c4 = await cycle(p4, plan4, "OPT-KOPI-SIUDAI", -3);
  await checkin(p4, c4, -3, "followed");


  return { invitePath: `/join/${p3.invite}`, accounts: ["dietitian.a@example.test", "dietitian.b@example.test", "admin@example.test"] };
}
