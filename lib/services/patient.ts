// Patient services: all patient database logic, independent of Next.js so it can be tested directly.
import { withActor, today, type Actor } from "../db";
import { cycleDays, optionById, resolveBarrier, type Answers } from "../domain";

export const addDays = (d: string, n: number) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

export type PatientState = Awaited<ReturnType<typeof loadPatientState>>;

export async function loadPatientState(actor: Actor) {
  return withActor(actor, async db => {
    const t = today();
    const patient = (await db.query("select id, code, reminder_time from patients where id = $1", [actor.id])).rows[0];
    const plan = (await db.query("select * from plans where patient_id = $1 and is_active", [actor.id])).rows[0] ?? null;
    const cycles = (await db.query("select * from cycles where patient_id = $1 order by start_date", [actor.id])).rows
      .map(c => c);
    const current = cycles.filter(c => !c.outcome).at(-1) ?? null;
    const checkins = current ? (await db.query("select * from checkins where cycle_id = $1 order by day", [current.id])).rows : [];
    const followups = (await db.query("select week from followups where patient_id = $1", [actor.id])).rows.map(r => r.week as number);
    const requests = (await db.query("select type, status, created_at from requests where patient_id = $1 order by created_at desc", [actor.id])).rows;
    const firstStart = cycles[0]?.start_date ?? null;
    const dueWeek = firstStart ? [4, 8, 12].find(w => addDays(firstStart, w * 7) <= t && !followups.includes(w)) ?? null : null;
    const days = current ? cycleDays(current.start_date) : [];
    const todayCheckin = checkins.find(k => k.day === t) ?? null;
    const phase: "no_plan" | "choose" | "followup" | "review" | "starts_tomorrow" | "checkin" | "done_today" =
      !plan ? "no_plan"
      : dueWeek ? "followup"
      : !current ? "choose"
      : t > current.end_date ? "review"
      : t < current.start_date ? "starts_tomorrow"
      : todayCheckin ? "done_today" : "checkin";
    return { today: t, patient, plan, current, checkins, days, todayCheckin, dueWeek, requests, cycleCount: cycles.length, phase,
      option: current ? optionById(current.option_id) ?? null : null };
  });
}

export async function chooseChange(actor: Actor, input: { chosen: string; answers: Record<string, Answers> }) {
  await withActor(actor, async db => {
    const plan = (await db.query("select id, preapproved_option_ids from plans where patient_id = $1 and is_active", [actor.id])).rows[0];
    if (!plan) throw new Error("No active plan");
    const open = (await db.query("select 1 from cycles where patient_id = $1 and outcome is null", [actor.id])).rows.length;
    if (open) throw new Error("A cycle is already in progress");
    for (const id of plan.preapproved_option_ids as string[]) {
      const a = input.answers[id] ?? { stall: "unsure", control: "yes", taste: 2, confidence: 6 };
      await db.query(`insert into choices(patient_id, plan_id, option_id, stall, control, taste, confidence, chosen) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [actor.id, plan.id, id, a.stall, a.control, a.taste, a.confidence, id === input.chosen]);
    }
    const t = today();
    await db.query("insert into cycles(patient_id, plan_id, option_id, start_date, end_date) values ($1,$2,$3,$4,$5)",
      [actor.id, plan.id, input.chosen, t, addDays(t, 6)]);
  });
}

export async function recordCheckin(actor: Actor, input: { outcome: "followed" | "no_opportunity"; context: string | null }) {
  await withActor(actor, async db => {
    const c = (await db.query("select id from cycles where patient_id = $1 and outcome is null order by start_date desc limit 1", [actor.id])).rows[0];
    if (!c) throw new Error("No cycle in progress");
    await db.query("insert into checkins(cycle_id, patient_id, day, outcome, context) values ($1,$2,$3,$4,$5)",
      [c.id, actor.id, today(), input.outcome, input.outcome === "followed" ? input.context : null]);
  });
}

/** A not-followed day: records the barrier and applies only what the permission rules allow. */
export async function recordBarrier(actor: Actor, input: { barrierId: string; accept: boolean; context: string | null }) {
  return withActor(actor, async db => {
    const c = (await db.query("select * from cycles where patient_id = $1 and outcome is null order by start_date desc limit 1", [actor.id])).rows[0];
    if (!c) throw new Error("No cycle in progress");
    const plan = (await db.query("select id, preapproved_option_ids from plans where patient_id = $1 and is_active", [actor.id])).rows[0];
    const r = resolveBarrier(input.barrierId, optionById(c.option_id)!, plan.preapproved_option_ids);
    let actionText = "kept current change";
    let permission: "automatic" | "requested" | null = null;
    const t = today();
    if (input.accept && r.action.kind !== "none") {
      permission = r.action.permission;
      if (r.action.kind === "switch") {
        await db.query("update cycles set end_date = $1, outcome = 'smaller_step' where id = $2", [t, c.id]);
        await db.query("insert into cycles(patient_id, plan_id, option_id, start_date, end_date) values ($1,$2,$3,$4,$5)",
          [actor.id, plan.id, r.action.toOptionId, addDays(t, 1), addDays(t, 7)]);
        actionText = `switched to ${optionById(r.action.toOptionId)!.name}`;
      } else if (r.action.kind === "request") {
        await db.query("insert into requests(patient_id, type, reason, detail) values ($1,$2,$3,$4)",
          [actor.id, r.action.requestType, r.action.reason, JSON.stringify(r.action.detail)]);
        actionText = "sent to dietitian for review";
      } else if (r.action.kind === "reminder") {
        await db.query("update patients set reminder_time = coalesce(reminder_time, '12:15') where id = $1", [actor.id]);
        actionText = "set an ordering reminder";
      } else if (r.action.kind === "backup_stall") actionText = "planned a back-up stall";
      else actionText = "will use the suggested phrase";
    }
    await db.query(`insert into checkins(cycle_id, patient_id, day, outcome, context, barrier_id, barrier_level, response_id, action, permission)
      values ($1,$2,$3,'not_followed',$4,$5,$6,$7,$8,$9)`, [c.id, actor.id, t, input.context, input.barrierId, r.level, r.responseId, actionText, permission]);
    return { resolution: r, actionText, permission };
  });
}

export async function closeCycle(actor: Actor, outcome: "continue" | "smaller_step" | "next_change") {
  await withActor(actor, async db => {
    const c = (await db.query("select * from cycles where patient_id = $1 and outcome is null order by start_date desc limit 1", [actor.id])).rows[0];
    if (!c) throw new Error("No cycle in progress");
    const plan = (await db.query("select id, preapproved_option_ids from plans where patient_id = $1 and is_active", [actor.id])).rows[0];
    await db.query("update cycles set outcome = $1 where id = $2", [outcome, c.id]);
    const t = today();
    let next: string | null = null;
    if (outcome === "continue") next = c.option_id;
    if (outcome === "smaller_step") {
      const cur = optionById(c.option_id)!;
      next = (plan.preapproved_option_ids as string[]).map(optionById).find(o => o && o.from_item === cur.from_item && o.step === "smaller" && o.id !== cur.id)?.id ?? null;
    }
    if (next) await db.query("insert into cycles(patient_id, plan_id, option_id, start_date, end_date) values ($1,$2,$3,$4,$5)", [actor.id, plan.id, next, t, addDays(t, 6)]);
  });
}

export async function recordFollowUp(actor: Actor, week: number, frequency: string) {
  if (![4, 8, 12].includes(week) || !["never", "some", "most", "every"].includes(frequency)) throw new Error("Invalid answer");
  await withActor(actor, db => db.query("insert into followups(patient_id, week, frequency) values ($1,$2,$3) on conflict do nothing", [actor.id, week, frequency]));
}

export async function updateReminder(actor: Actor, time: string | null) {
  const value = time && /^\d{2}:\d{2}$/.test(time) ? time : null;
  await withActor(actor, db => db.query("update patients set reminder_time = $1 where id = $2", [value, actor.id]));
}
