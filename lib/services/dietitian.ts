// Dietitian services. Row-level security limits every query to the dietitian's own patients.
import { withActor, today, type Actor } from "../db";
import { adherence, flagsFor, optionById, BARRIERS, OPTIONS, type Level } from "../domain";
import { newToken, hashToken } from "../tokens";
import { addDays } from "./patient";

export async function listPatients(actor: Actor) {
  return withActor(actor, async db => {
    const t = today();
    const patients = (await db.query("select id, code, status from patients order by code")).rows;
    const out: { id: string; code: string; status: string; option: string | null; adherence: ReturnType<typeof adherence>; flags: ReturnType<typeof flagsFor> }[] = [];
    for (const p of patients) {
      const cycle = (await db.query("select * from cycles where patient_id = $1 order by start_date desc limit 1", [p.id])).rows[0] ?? null;
      const checkins = cycle ? (await db.query("select day, outcome from checkins where cycle_id = $1", [cycle.id])).rows : [];
      const awaiting = (await db.query("select count(*)::int n from requests where patient_id = $1 and status = 'awaiting'", [p.id])).rows[0].n;
      out.push({
        ...p,
        option: cycle ? optionById(cycle.option_id)?.name ?? null : null,
        adherence: adherence(checkins),
        flags: flagsFor({ checkins, cycleStart: cycle && !cycle.outcome ? cycle.start_date : null, awaitingRequests: awaiting, today: t })
      });
    }
    return out;
  });
}

export function discussionPoint(counts: Record<Level, number>, top: { id: string; n: number } | null) {
  if (!top) return "No barriers recorded yet. Continue the current change.";
  const b = BARRIERS.find(x => x.id === top.id)!;
  if (top.id === "taste") return `Taste came up ${top.n}×. Consider agreeing a gentler interim step and reassessing acceptability.`;
  if (b.level === "social") return `Social situations came up ${top.n}×. Discuss which drinks are ordered by others and agree a phrase the patient can use.`;
  if (b.level === "environmental") return `Stall or time constraints came up ${top.n}×. Consider pre-approving a change that doesn't depend on a particular stall.`;
  return `"${b.text}" came up ${top.n}×. Explore a practical prompt such as an ordering plan or reminder.`;
}

export async function patientSummary(actor: Actor, patientId: string) {
  return withActor(actor, async db => {
    const t = today();
    const p = (await db.query("select id, code, status, reminder_time from patients where id = $1", [patientId])).rows[0];
    if (!p) return null; // not this dietitian's patient: RLS returns nothing
    await db.query("select log_view($1)", [patientId]);
    const plan = (await db.query("select * from plans where patient_id = $1 and is_active", [patientId])).rows[0] ?? null;
    const cycles = (await db.query("select * from cycles where patient_id = $1 order by start_date", [patientId])).rows;
    const checkins = (await db.query("select * from checkins where patient_id = $1 order by day", [patientId])).rows;
    const requests = (await db.query("select * from requests where patient_id = $1 order by created_at desc", [patientId])).rows;
    const followups = (await db.query("select week, frequency from followups where patient_id = $1 order by week", [patientId])).rows;
    const current = cycles.filter(c => !c.outcome).at(-1) ?? cycles.at(-1) ?? null;
    const currentCheckins = current ? checkins.filter(k => k.cycle_id === current.id) : [];

    const counts: Record<Level, number> = { personal: 0, social: 0, environmental: 0 };
    const byBarrier = new Map<string, number>();
    for (const k of checkins) if (k.outcome === "not_followed" && k.barrier_level) {
      counts[k.barrier_level as Level]++;
      byBarrier.set(k.barrier_id, (byBarrier.get(k.barrier_id) ?? 0) + 1);
    }
    const topEntry = [...byBarrier.entries()].sort((a, b) => b[1] - a[1])[0];
    const top = topEntry ? { id: topEntry[0], n: topEntry[1] } : null;
    const awaiting = requests.filter(r => r.status === "awaiting").length;

    return {
      patient: p, plan, current, today: t,
      option: current ? optionById(current.option_id) ?? null : null,
      currentCheckins,
      cycleAdherence: adherence(currentCheckins),
      overallAdherence: adherence(checkins),
      cycles: cycles.map(c => ({ ...c, option: optionById(c.option_id)?.name, adherence: adherence(checkins.filter(k => k.cycle_id === c.id)) })),
      barrierCounts: counts,
      topBarrier: top ? { ...top, text: BARRIERS.find(b => b.id === top.id)!.text } : null,
      discussion: discussionPoint(counts, top),
      adaptations: checkins.filter(k => k.outcome === "not_followed").map(k => ({ day: k.day, barrier: BARRIERS.find(b => b.id === k.barrier_id)?.text ?? "No reason given", level: k.barrier_level, action: k.action, permission: k.permission })),
      requests, followups,
      flags: flagsFor({ checkins: currentCheckins, cycleStart: current && !current.outcome ? current.start_date : null, awaitingRequests: awaiting, today: t })
    };
  });
}

export async function enrolPatient(actor: Actor, input: { code: string; preapproved: string[]; reviewDate: string | null; inclusionConfirmed: boolean }) {
  if (!input.inclusionConfirmed) throw new Error("Confirm the inclusion criteria first");
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z]-\d{4}$/.test(code)) throw new Error("Use a code like P-0004");
  const valid = input.preapproved.filter(id => OPTIONS.some(o => o.id === id));
  if (valid.length === 0) throw new Error("Pre-approve at least one option");
  const token = newToken();
  await withActor(actor, async db => {
    const me = (await db.query("select clinic_id from dietitians where id = $1", [actor.id])).rows[0];
    const p = (await db.query("insert into patients(code, clinic_id, dietitian_id, invite_token_hash, status) values ($1,$2,$3,$4,'invited') returning id",
      [code, me.clinic_id, actor.id, hashToken(token)])).rows[0];
    const t = today();
    await db.query(`insert into plans(patient_id, version, goal, scope, preapproved_option_ids, start_date, review_date, approved_by)
      values ($1,1,'Reduce added sugar from drinks','drink_sugar',$2,$3,$4,$5)`, [p.id, valid, t, input.reviewDate ?? addDays(t, 14), actor.id]);
  });
  return { code, invitePath: `/join/${token}` };
}

/** The only path by which a goal or pre-approved list changes: a dietitian's explicit decision, as a new plan version. */
export async function decideRequest(actor: Actor, requestId: string, decision: "approved" | "held") {
  await withActor(actor, async db => {
    const r = (await db.query("select * from requests where id = $1 and status = 'awaiting'", [requestId])).rows[0];
    if (!r) throw new Error("Request not found or already decided");
    await db.query("update requests set status = $1 where id = $2", [decision, requestId]);
    if (decision !== "approved") return;
    if (r.type === "switch_not_preapproved" && r.detail?.option_id) {
      const plan = (await db.query("select * from plans where patient_id = $1 and is_active", [r.patient_id])).rows[0];
      const pre = Array.from(new Set([...(plan.preapproved_option_ids as string[]), r.detail.option_id]));
      await db.query("update plans set is_active = false where id = $1", [plan.id]);
      await db.query(`insert into plans(patient_id, version, goal, scope, preapproved_option_ids, start_date, review_date, approved_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8)`, [r.patient_id, plan.version + 1, plan.goal, plan.scope, pre, today(), plan.review_date, actor.id]);
    }
    // gentler_step and exception_day: approval is recorded; the change itself is agreed with the patient at the visit.
  });
}

export async function updatePreapproved(actor: Actor, patientId: string, preapproved: string[]) {
  const valid = preapproved.filter(id => OPTIONS.some(o => o.id === id));
  if (valid.length === 0) throw new Error("Pre-approve at least one option");
  await withActor(actor, async db => {
    const plan = (await db.query("select * from plans where patient_id = $1 and is_active", [patientId])).rows[0];
    if (!plan) throw new Error("No active plan");
    await db.query("update plans set is_active = false where id = $1", [plan.id]);
    await db.query(`insert into plans(patient_id, version, goal, scope, preapproved_option_ids, start_date, review_date, approved_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`, [patientId, plan.version + 1, plan.goal, plan.scope, valid, today(), plan.review_date, actor.id]);
  });
}
