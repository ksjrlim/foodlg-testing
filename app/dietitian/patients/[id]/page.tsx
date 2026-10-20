import Link from "next/link";
import { notFound } from "next/navigation";
import { Top } from "@/components/Top";
import { Week, Legend } from "@/components/Week";
import { requireDietitian, decide, savePreapproved } from "@/lib/dietitian";
import { patientSummary } from "@/lib/services/dietitian";
import { cycleDays, LEVEL_LABEL, OPTIONS, type Level } from "@/lib/domain";

export const dynamic = "force-dynamic";

const LEVEL_COLOR: Record<Level, string> = { personal: "var(--personal)", social: "var(--social)", environmental: "var(--env)" };
const REQUEST_LABEL: Record<string, string> = {
  switch_not_preapproved: "Try an option you haven't pre-approved",
  gentler_step: "A gentler interim step",
  exception_day: "One planned exception day a week"
};

export default async function PatientSummary({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireDietitian();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const s = await patientSummary(actor, id);
  if (!s) notFound();
  const maxBarrier = Math.max(1, ...Object.values(s.barrierCounts));
  const awaiting = s.requests.filter(r => r.status === "awaiting");

  return (
    <main className="shell">
      <Top label="Pre-appointment summary" signedIn />
      <Link href="/dietitian" className="small">← All patients</Link>
      <div className="row">
        <h1>{s.patient.code}</h1>
        {s.flags.length ? <span className="tag t-warn">Review suggested</span> : <span className="tag t-good">Nothing flagged</span>}
      </div>
      {s.plan && <div className="goal"><b>Agreed goal (plan version {s.plan.version})</b>{s.plan.goal} · review {s.plan.review_date ?? "not set"}</div>}

      {s.flags.length > 0 && <div className="stack">{s.flags.map((f, i) => <p key={i} className={`flag ${f.kind === "data_gap" ? "gap" : ""}`}>{f.text}</p>)}</div>}

      <div className="grid2">
        <section className="card">
          <h2>Current change</h2>
          <p><b>{s.option?.name ?? "None chosen yet"}</b>{s.option && <span className="muted small"> · {s.option.display_claim}</span>}</p>
          <div className="kpis">
            <div className="kpi"><div className="v">{s.cycleAdherence.opportunity ? `${s.cycleAdherence.followed}/${s.cycleAdherence.opportunity}` : "—"}</div><div className="k">Followed, of days with kopi or teh (this cycle)</div></div>
            <div className="kpi"><div className="v">{s.cycleAdherence.noOpportunity}</div><div className="k">Days without kopi or teh</div></div>
            <div className="kpi"><div className="v">{s.cycles.length}</div><div className="k">Cycles started</div></div>
          </div>
          {s.current && <><Week days={cycleDays(s.current.start_date)} checkins={s.currentCheckins} today={s.today} /><Legend /></>}
          <p className="muted small">Days with no entry are data gaps. They don't show whether the goal was followed.</p>
        </section>

        <section className="card">
          <h2>What got in the way</h2>
          {(Object.keys(s.barrierCounts) as Level[]).map(l => (
            <div key={l} className="bar">
              <span>{LEVEL_LABEL[l]}</span>
              <div className="track"><div className="fill" style={{ width: `${(s.barrierCounts[l] / maxBarrier) * 100}%`, background: LEVEL_COLOR[l] }} /></div>
              <b>{s.barrierCounts[l]}</b>
            </div>
          ))}
          {s.topBarrier && <p className="small">Most common: <b>{s.topBarrier.text}</b> ({s.topBarrier.n}×)</p>}
          <div className="response r-personal"><b>Suggested discussion</b><p>{s.discussion}</p></div>
          <p className="muted small">Suggestions support your judgement. FoodLG never changes an agreed goal without your approval.</p>
        </section>
      </div>

      <section className="card">
        <h2>Requests ({awaiting.length} awaiting)</h2>
        {s.requests.length === 0 && <p className="muted">No requests.</p>}
        {s.requests.map(r => (
          <div key={r.id} className={r.status === "awaiting" ? "flag" : "card"} style={{ gap: 6 }}>
            <b>{REQUEST_LABEL[r.type] ?? r.type}</b>
            <span className="small">{r.reason}</span>
            <span className="muted small">Status: {r.status}{r.decided_at ? ` · ${new Date(r.decided_at).toISOString().slice(0, 10)}` : ""}</span>
            {r.status === "awaiting" && (
              <form action={decide} className="row" style={{ justifyContent: "flex-start" }}>
                <input type="hidden" name="request" value={r.id} />
                <input type="hidden" name="patient" value={s.patient.id} />
                <button className="primary" type="submit" name="decision" value="approved">Approve</button>
                <button className="ghost" type="submit" name="decision" value="held">Discuss at next visit</button>
              </form>
            )}
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Adaptations tried</h2>
        {s.adaptations.length === 0 ? <p className="muted">None yet.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>Day</th><th>Reason</th><th>Level</th><th>What happened</th><th>Permission</th></tr></thead>
            <tbody>{s.adaptations.map((a, i) => (
              <tr key={i}><td>{a.day}</td><td>{a.barrier}</td><td>{a.level ? <span className={`tag t-${a.level}`}>{LEVEL_LABEL[a.level as Level]}</span> : "—"}</td><td>{a.action}</td><td>{a.permission ?? "—"}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h2>Follow-up checks</h2>
        {s.followups.length === 0 ? <p className="muted">None answered yet (due at weeks 4, 8 and 12).</p> :
          <p>{s.followups.map(f => `Week ${f.week}: ${f.frequency}`).join(" · ")}</p>}
        <p className="muted small">Self-reported. Sustained change is assessed separately by the study team.</p>
      </section>

      {s.plan && (
        <form action={savePreapproved} className="card">
          <h2>Pre-approved options</h2>
          <input type="hidden" name="patient" value={s.patient.id} />
          {OPTIONS.map(o => (
            <label key={o.id} className="small" style={{ display: "flex", gap: 8 }}>
              <input type="checkbox" name="preapproved" value={o.id} defaultChecked={(s.plan.preapproved_option_ids as string[]).includes(o.id)} />
              {o.from_item} → {o.name}
            </label>
          ))}
          <button className="ghost" type="submit">Save as a new plan version</button>
        </form>
      )}
    </main>
  );
}
