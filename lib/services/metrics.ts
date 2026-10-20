// Study metrics and export. Behaviour-change outcomes and engagement are computed and reported separately.
import { withActor, today, type Actor } from "../db";
import { computeMetrics } from "../domain";

type Mode = "synthetic" | "real";

async function scopedPatients(db: import("pg").PoolClient, mode: Mode) {
  return (await db.query(
    `select p.id, p.code, p.status, p.consent_version, p.consent_at, p.dietitian_id, c.is_synthetic
       from patients p join clinics c on c.id = p.clinic_id
      where c.is_synthetic = $1 and p.status <> 'invited' order by p.code`, [mode === "synthetic"])).rows;
}

export async function studyMetrics(actor: Actor, mode: Mode = "synthetic") {
  return withActor(actor, async db => {
    const patients = await scopedPatients(db, mode);
    const ids = patients.map(p => p.id);
    const cycles = (await db.query("select id, patient_id, start_date from cycles where patient_id = any($1)", [ids])).rows;
    const checkins = (await db.query("select patient_id, cycle_id, day, outcome, barrier_level, barrier_id from checkins where patient_id = any($1)", [ids])).rows;
    const followups = (await db.query("select patient_id, week, frequency from followups where patient_id = any($1)", [ids])).rows;
    const assessments = (await db.query("select count(*)::int n, count(distinct patient_id)::int patients from study_assessments where patient_id = any($1)", [ids])).rows[0];
    const m = computeMetrics({ patientIds: ids, cycles, checkins, followups, today: today() });

    // Provider continuation: dietitians who acted (enrolled, reviewed, decided) in weeks 0–4 and 4–8 after their first action.
    const acts = (await db.query(
      `select a.actor_id, a.at from audit_events a
        where a.actor_role = 'dietitian' and a.actor_id = any($1)`, [Array.from(new Set(patients.map(p => p.dietitian_id)))])).rows;
    const byD = new Map<string, number[]>();
    for (const a of acts) byD.set(a.actor_id, [...(byD.get(a.actor_id) ?? []), new Date(a.at).getTime()]);
    const week = 7 * 864e5;
    let active4 = 0, active8 = 0;
    for (const times of byD.values()) {
      const first = Math.min(...times);
      if (times.some(t => t - first >= 4 * week)) active4++;
      if (times.some(t => t - first >= 8 * week)) active8++;
    }

    // Workflow burden: summary views per patient (minutes come from the dietitian survey, not the app)
    const views = (await db.query(
      `select count(*)::int n from audit_events where action = 'view_summary' and entity_id = any($1)`, [ids])).rows[0].n;

    return {
      mode, generatedAt: new Date().toISOString(),
      behaviour: { ...m.behaviour, studyAssessments: assessments },
      engagement: {
        ...m.engagement,
        providerContinuation: { dietitians: byD.size, activeAfter4Weeks: active4, activeAfter8Weeks: active8 },
        summaryViewsPerPatient: ids.length ? views / ids.length : null
      }
    };
  });
}

/* ---------- pseudonymised CSV export ---------- */

export const EXPORT_TABLES = ["patients", "plans", "cycles", "checkins", "requests", "followups", "study_assessments"] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join(";") : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  // neutralise spreadsheet formula injection, then quote
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export async function exportCsv(actor: Actor, table: ExportTable, mode: Mode) {
  if (actor.role !== "admin") throw new Error("Export is for the study admin only");
  return withActor(actor, async db => {
    const patients = await scopedPatients(db, mode);
    const ids = patients.map(p => p.id);
    const code = new Map(patients.map(p => [p.id, p.code]));
    const dietitianCodes = new Map(Array.from(new Set(patients.map(p => p.dietitian_id))).map((d, i) => [d, `D-${String(i + 1).padStart(2, "0")}`]));
    const queries: Record<ExportTable, string> = {
      patients: "select id as patient_id, status, consent_version, consent_at, dietitian_id from patients where id = any($1)",
      plans: "select patient_id, version, goal, scope, preapproved_option_ids, start_date, review_date, is_active, approved_by as dietitian_id from plans where patient_id = any($1) order by patient_id, version",
      cycles: "select patient_id, option_id, start_date, end_date, outcome from cycles where patient_id = any($1) order by patient_id, start_date",
      checkins: "select patient_id, day, outcome, context, barrier_id, barrier_level, response_id, action, permission from checkins where patient_id = any($1) order by patient_id, day",
      requests: "select patient_id, type, reason, status, decided_by as dietitian_id, decided_at, created_at from requests where patient_id = any($1) order by created_at",
      followups: "select patient_id, week, frequency from followups where patient_id = any($1) order by patient_id, week",
      study_assessments: "select patient_id, timepoint, instrument, result, assessor from study_assessments where patient_id = any($1) order by patient_id"
    };
    const rows = (await db.query(queries[table], [ids])).rows.map(r => {
      const out: Record<string, unknown> = { patient_code: code.get(r.patient_id) };
      for (const [k, v] of Object.entries(r)) {
        if (k === "patient_id") continue;
        out[k] = k === "dietitian_id" ? (v ? dietitianCodes.get(v as string) ?? "D-?" : null) : v;
      }
      return out;
    });
    const headers = rows[0] ? Object.keys(rows[0]) : ["patient_code"];
    await db.query("select log_export($1, $2)", [table, mode]);
    return [headers.join(","), ...rows.map(r => headers.map(h => csvCell(r[h])).join(","))].join("\n") + "\n";
  });
}
