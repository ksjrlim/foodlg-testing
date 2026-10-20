// Pure domain logic for the FoodLG Validation MVP. No I/O here, so every rule is unit-testable.
import optionsLib from "../rules/options.json";
import barrierLib from "../rules/barriers.json";

export type Option = (typeof optionsLib.options)[number];
export type Barrier = (typeof barrierLib.barriers)[number];
export type Level = "personal" | "social" | "environmental";
export type Outcome = "followed" | "not_followed" | "no_opportunity";

export const OPTIONS: Option[] = optionsLib.options;
export const RULE_VERSION = `options@${optionsLib.version}+barriers@${barrierLib.version}`;
export const BARRIERS: Barrier[] = barrierLib.barriers;
export const LEVEL_LABEL: Record<Level, string> = barrierLib.levels as Record<Level, string>;

export const optionById = (id: string) => OPTIONS.find(o => o.id === id);

/* ---------------- ranking: plan → feasibility → benefit → preference ---------------- */

export interface Answers { stall: "yes" | "unsure" | "no"; control: "yes" | "no"; taste: number; confidence: number }
export interface Ranked { option: Option; status: "feasible" | "not_feasible"; reasons: string[]; preference: number }

export function rankOptions(preapproved: string[], answers: Record<string, Answers | undefined>): Ranked[] {
  const rows: Ranked[] = OPTIONS.filter(o => preapproved.includes(o.id)).map(option => {
    const a = answers[option.id];
    const reasons: string[] = [];
    let status: Ranked["status"] = "feasible";
    if (a) {
      if (a.stall === "no") { status = "not_feasible"; reasons.push("Not available at your usual stall"); }
      if (a.control === "no") { status = "not_feasible"; reasons.push("Hard to stick to when eating with others"); }
      if (status === "feasible" && a.stall === "unsure") reasons.push("Check with your stall first");
      if (status === "feasible" && (a.taste === 1 || a.confidence <= 3)) reasons.push("Bigger change, but you rated it hard: a smaller step may stick better");
    }
    const preference = a ? a.taste * 10 + a.confidence : 0;
    return { option, status, reasons, preference };
  });
  const benefit = (o: Option) => (o.benefit_tsp == null ? -1 : o.benefit_tsp);
  return rows.sort((x, y) =>
    (x.status === "feasible" ? 0 : 1) - (y.status === "feasible" ? 0 : 1)
    || benefit(y.option) - benefit(x.option)
    || y.preference - x.preference
    || x.option.id.localeCompare(y.option.id));
}

/* ---------------- barrier → response, with permission decision ---------------- */

export interface Resolution {
  responseId: string; barrierId: string; level: Level; title: string; body: string; script: string | null;
  action:
    | { kind: "none" }
    | { kind: "script" | "reminder" | "backup_stall"; permission: "automatic" }
    | { kind: "switch"; permission: "automatic"; toOptionId: string; label: string }
    | { kind: "request"; permission: "requested"; requestType: string; reason: string; label: string; detail: Record<string, unknown> };
}

const shortName = (o: Option) => o.name.replace(/^(Kopi|Teh)\s*-?\s*/i, "").toLowerCase() || o.name.toLowerCase();

function switchTarget(current: Option, target: string): Option | undefined {
  const sameDrink = OPTIONS.filter(o => o.id !== current.id && o.from_item === current.from_item);
  if (target === "smaller_same_drink") return sameDrink.find(o => o.step === "smaller");
  if (target === "stall_independent_same_drink") return sameDrink.find(o => !o.stall_dependent) ?? OPTIONS.find(o => o.id === "OPT-PLAIN-WATER" && o.id !== current.id);
  return undefined;
}

/** Decides the response for a barrier. Never changes the plan: anything outside the pre-approved list becomes a request. */
export function resolveBarrier(barrierId: string, current: Option, preapproved: string[]): Resolution {
  const barrier = BARRIERS.find(b => b.id === barrierId);
  if (!barrier) throw new Error(`Unknown barrier ${barrierId}`);
  const candidates = barrierLib.responses.filter(r => r.barrier === barrierId);
  const resp = candidates.find(r => !("when" in r) || (r.when === "current_step_bigger" ? current.step === "bigger" : current.step === "smaller")) ?? candidates[0];
  const fill = (s: string) => s.replace("{{option}}", current.name).replace("{{option_short}}", shortName(current));
  const base = { responseId: resp.id, barrierId, level: barrier.level as Level, title: resp.title, body: resp.body, script: "script" in resp && resp.script ? fill(resp.script) : null };
  const a = resp.action as { type: string; target?: string; reason?: string };

  if (a.type === "script" || a.type === "reminder" || a.type === "backup_stall") {
    return { ...base, action: { kind: a.type, permission: "automatic" } };
  }
  if (a.type === "switch") {
    const to = switchTarget(current, a.target!);
    if (!to) return { ...base, action: { kind: "none" } };
    if (preapproved.includes(to.id)) {
      return { ...base, action: { kind: "switch", permission: "automatic", toOptionId: to.id, label: `Switch to ${to.name}` } };
    }
    return { ...base, action: { kind: "request", permission: "requested", requestType: "switch_not_preapproved",
      reason: `Patient would like to try ${to.name}, which is not pre-approved in their plan.`, label: `Ask my dietitian about ${to.name}`, detail: { option_id: to.id } } };
  }
  // exception_day, gentler_step: always need approval
  return { ...base, action: { kind: "request", permission: "requested", requestType: a.type, reason: a.reason ?? "Patient request", label: "Ask my dietitian", detail: {} } };
}

/* ---------------- cycles ---------------- */

export const CYCLE_DAYS = 7;
export function cycleDays(start: string): string[] {
  const d0 = new Date(start + "T00:00:00Z");
  return Array.from({ length: CYCLE_DAYS }, (_, i) => new Date(d0.getTime() + i * 864e5).toISOString().slice(0, 10));
}

/* ---------------- metrics: behaviour and engagement kept separate ---------------- */

export interface CheckinRow { patient_id: string; cycle_id: string; day: string; outcome: Outcome; barrier_level: Level | null; barrier_id: string | null }
export interface CycleRow { id: string; patient_id: string; start_date: string }
export interface FollowupRow { patient_id: string; week: number; frequency: "never" | "some" | "most" | "every" }

export function adherence(rows: Pick<CheckinRow, "outcome">[]) {
  const followed = rows.filter(r => r.outcome === "followed").length;
  const notFollowed = rows.filter(r => r.outcome === "not_followed").length;
  const opportunity = followed + notFollowed;
  return { followed, notFollowed, noOpportunity: rows.filter(r => r.outcome === "no_opportunity").length, opportunity, rate: opportunity ? followed / opportunity : null };
}

export function computeMetrics(input: { patientIds: string[]; cycles: CycleRow[]; checkins: CheckinRow[]; followups: FollowupRow[]; today: string }) {
  const { patientIds, cycles, checkins, followups, today } = input;
  const n = patientIds.length;
  const firstCycle = new Map<string, CycleRow>();
  for (const c of [...cycles].sort((a, b) => a.start_date.localeCompare(b.start_date))) if (!firstCycle.has(c.patient_id)) firstCycle.set(c.patient_id, c);

  const adopted = patientIds.filter(p => { const c = firstCycle.get(p); return c && checkins.some(k => k.cycle_id === c.id && k.outcome === "followed"); }).length;
  const adh = adherence(checkins);

  const sustained: Record<number, { answered: number; sustained: number; rate: number | null }> = {};
  for (const w of [4, 8, 12]) {
    const rows = followups.filter(f => f.week === w);
    const s = rows.filter(f => f.frequency === "most" || f.frequency === "every").length;
    sustained[w] = { answered: rows.length, sustained: s, rate: rows.length ? s / rows.length : null };
  }

  const cyclesPer = new Map<string, number>();
  cycles.forEach(c => cyclesPer.set(c.patient_id, (cyclesPer.get(c.patient_id) ?? 0) + 1));
  const repeat = patientIds.filter(p => (cyclesPer.get(p) ?? 0) >= 2).length;

  // engagement: days elapsed in each cycle (up to today) with any check-in
  let elapsed = 0, withCheckin = 0;
  for (const c of cycles) for (const d of cycleDays(c.start_date)) {
    if (d > today) continue;
    elapsed++;
    if (checkins.some(k => k.cycle_id === c.id && k.day === d)) withCheckin++;
  }

  const barriers = { personal: 0, social: 0, environmental: 0 } as Record<Level, number>;
  checkins.forEach(k => { if (k.outcome === "not_followed" && k.barrier_level) barriers[k.barrier_level]++; });

  return {
    behaviour: {
      enrolled: n,
      adoptionRate: n ? adopted / n : null,
      adherenceOnOpportunityDays: adh.rate,
      opportunityDays: adh.opportunity,
      noOpportunityDays: adh.noOpportunity,
      sustainedSelfReport: sustained,
      repeatCycleRate: n ? repeat / n : null
    },
    engagement: {
      checkinCompletion: elapsed ? withCheckin / elapsed : null,
      dataGapDays: elapsed - withCheckin,
      barrierProfile: barriers
    }
  };
}

/* ---------------- dietitian flags (exception-based) ---------------- */

export function flagsFor(input: { checkins: Pick<CheckinRow, "day" | "outcome">[]; cycleStart: string | null; awaitingRequests: number; today: string }) {
  const flags: { kind: "request" | "consecutive_usual" | "data_gap"; text: string }[] = [];
  if (input.awaitingRequests > 0) flags.push({ kind: "request", text: `${input.awaitingRequests} request${input.awaitingRequests > 1 ? "s" : ""} awaiting your decision` });
  const sorted = [...input.checkins].sort((a, b) => a.day.localeCompare(b.day));
  let run = 0, maxRun = 0;
  for (const c of sorted) { if (c.outcome === "not_followed") { run++; maxRun = Math.max(maxRun, run); } else if (c.outcome === "followed") run = 0; }
  if (maxRun >= 3) flags.push({ kind: "consecutive_usual", text: `${maxRun} days in a row with the usual drink instead` });
  if (input.cycleStart) {
    const days = cycleDays(input.cycleStart).filter(d => d <= input.today);
    const recorded = new Set(sorted.map(c => c.day));
    let gap = 0;
    for (const d of [...days].reverse()) { if (recorded.has(d)) break; gap++; }
    if (gap >= 3) flags.push({ kind: "data_gap", text: `No check-in for ${gap} days (data gap, not a sign the goal was missed)` });
  }
  return flags;
}
