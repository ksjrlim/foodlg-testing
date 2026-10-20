import Link from "next/link";
import { redirect } from "next/navigation";
import { Top } from "@/components/Top";
import { requirePatient, loadPatientState, applyBarrier } from "@/lib/patient";
import { BARRIERS, LEVEL_LABEL, resolveBarrier, type Level } from "@/lib/domain";

export const dynamic = "force-dynamic";

export default async function Adapt({ searchParams }: { searchParams: Promise<{ b?: string; context?: string }> }) {
  const actor = await requirePatient();
  const s = await loadPatientState(actor);
  if (s.phase !== "checkin" || !s.option) redirect("/patient");
  const { b, context } = await searchParams;
  const ctx = context ? `&context=${encodeURIComponent(context)}` : "";

  if (!b || !BARRIERS.some(x => x.id === b)) {
    const levels: Level[] = ["personal", "social", "environmental"];
    return (
      <main className="shell narrow">
        <Top label={`Patient ${s.patient.code}`} signedIn />
        <h1>What got in the way today?</h1>
        <p className="muted">No judgement. Knowing why helps FoodLG suggest something that fits better.</p>
        {levels.map(l => (
          <section key={l} className="stack" aria-labelledby={`h-${l}`}>
            <h3 id={`h-${l}`}><span className={`tag t-${l}`}>{LEVEL_LABEL[l]}</span></h3>
            {BARRIERS.filter(x => x.level === l).map(x => (
              <Link key={x.id} className="choice" href={`/patient/adapt?b=${x.id}${ctx}`}>{x.text}</Link>
            ))}
          </section>
        ))}
        <Link className="btn ghost" href="/patient">Back</Link>
      </main>
    );
  }

  const r = resolveBarrier(b, s.option, s.plan.preapproved_option_ids);
  const barrier = BARRIERS.find(x => x.id === b)!;
  return (
    <main className="shell narrow">
      <Top label={`Patient ${s.patient.code}`} signedIn />
      <div><span className={`tag t-${r.level}`}>{LEVEL_LABEL[r.level]}</span><h1 style={{ marginTop: 6 }}>{barrier.text}</h1></div>
      <div className={`response r-${r.level}`}>
        <h2>{r.title}</h2>
        <p>{r.body}</p>
        {r.script && <p className="script">{r.script}</p>}
      </div>
      {r.action.kind === "request" && (
        <p className="flag">This would change what you agreed with your dietitian, so FoodLG won't change it on its own. It will be sent to them to decide.</p>
      )}
      <form action={applyBarrier} className="stack">
        <input type="hidden" name="barrier" value={b} />
        {context && <input type="hidden" name="context" value={context} />}
        {r.action.kind !== "none" && (
          <button className="primary" type="submit" name="accept" value="yes">
            {r.action.kind === "switch" ? r.action.label
              : r.action.kind === "request" ? r.action.label
              : r.action.kind === "reminder" ? "Remind me each day"
              : r.action.kind === "backup_stall" ? "I'll plan a back-up stall"
              : "I'll try this"}
          </button>
        )}
        <button className="ghost" type="submit" name="accept" value="no">Keep my current change</button>
      </form>
      <Link className="small" href="/patient/adapt">Choose a different reason</Link>
    </main>
  );
}
