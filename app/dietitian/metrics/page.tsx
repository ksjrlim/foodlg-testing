import { redirect } from "next/navigation";
import Link from "next/link";
import { Top } from "@/components/Top";
import { requireDietitian } from "@/lib/dietitian";
import { studyMetrics, EXPORT_TABLES } from "@/lib/services/metrics";

export const dynamic = "force-dynamic";
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export default async function Metrics({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const actor = await requireDietitian();
  if (actor.role !== "admin") redirect("/dietitian");
  const mode = (await searchParams).mode === "real" ? "real" : "synthetic";
  const m = await studyMetrics(actor, mode);
  const b = m.behaviour, e = m.engagement;
  return (
    <main className="shell">
      <Top label="Study admin" signedIn />
      <Link href="/dietitian" className="small">← Patients</Link>
      <div className="row">
        <h1>Study metrics</h1>
        <div className="row" style={{ gap: 6 }}>
          <Link className={`btn ${mode === "synthetic" ? "primary" : "ghost"}`} href="?mode=synthetic">Synthetic</Link>
          <Link className={`btn ${mode === "real" ? "primary" : "ghost"}`} href="?mode=real">Real</Link>
        </div>
      </div>
      <p className="muted small">Showing {mode} clinics only. Synthetic and real data are never combined. {b.enrolled} enrolled patients.</p>

      <section className="card">
        <h2>Behaviour-change outcomes</h2>
        <div className="kpis">
          <div className="kpi"><div className="v">{pct(b.adoptionRate)}</div><div className="k">Adoption: followed at least once in first cycle</div></div>
          <div className="kpi"><div className="v">{pct(b.adherenceOnOpportunityDays)}</div><div className="k">Adherence on days with kopi or teh ({b.opportunityDays} days)</div></div>
          {[4, 8, 12].map(w => (
            <div key={w} className="kpi"><div className="v">{pct(b.sustainedSelfReport[w].rate)}</div><div className="k">Week {w}: "most days" or "every time" (n={b.sustainedSelfReport[w].answered}, self-report)</div></div>
          ))}
          <div className="kpi"><div className="v">{pct(b.repeatCycleRate)}</div><div className="k">Started a second or later cycle</div></div>
          <div className="kpi"><div className="v">{b.studyAssessments.patients}</div><div className="k">Patients with a study beverage assessment</div></div>
        </div>
        <p className="muted small">No-opportunity days ({b.noOpportunityDays}) and data gaps are excluded from adherence. Sustained change is decided by the study assessment and comparator arm, not by self-report alone.</p>
      </section>

      <section className="card">
        <h2>Engagement and workflow</h2>
        <p className="muted small">These show whether the tool is used. They are not evidence of behaviour change.</p>
        <div className="kpis">
          <div className="kpi"><div className="v">{pct(e.checkinCompletion)}</div><div className="k">Check-in completion</div></div>
          <div className="kpi"><div className="v">{e.dataGapDays}</div><div className="k">Data-gap days</div></div>
          <div className="kpi"><div className="v">{e.providerContinuation.activeAfter4Weeks}/{e.providerContinuation.dietitians}</div><div className="k">Dietitians still active after 4 weeks</div></div>
          <div className="kpi"><div className="v">{e.summaryViewsPerPatient?.toFixed(1) ?? "—"}</div><div className="k">Summary views per patient</div></div>
        </div>
        <p className="small">Barriers on usual-drink days: personal {e.barrierProfile.personal} · social {e.barrierProfile.social} · environmental {e.barrierProfile.environmental}</p>
      </section>

      <section className="card">
        <h2>Pseudonymised export ({mode})</h2>
        <p className="muted small">Patient codes only; dietitians appear as D-01, D-02. Each export is recorded in the audit log.</p>
        <div className="row" style={{ justifyContent: "flex-start" }}>
          {EXPORT_TABLES.map(t => <a key={t} className="btn ghost" href={`/dietitian/export?table=${t}&mode=${mode}`}>{t}.csv</a>)}
        </div>
      </section>
    </main>
  );
}
