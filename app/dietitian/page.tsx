import Link from "next/link";
import { Top } from "@/components/Top";
import { EnrolForm } from "@/components/EnrolForm";
import { requireDietitian, enrol } from "@/lib/dietitian";
import { listPatients } from "@/lib/services/dietitian";

export const dynamic = "force-dynamic";

export default async function DietitianHome() {
  const actor = await requireDietitian();
  const patients = await listPatients(actor);
  const flagged = patients.filter(p => p.flags.length > 0);
  return (
    <main className="shell">
      <Top label={actor.role === "admin" ? "Study admin" : "Dietitian"} signedIn />
      <h1>Your patients</h1>
      <p className="muted">Only items that need you are flagged. There's no need to check daily.</p>

      <section className="card" aria-labelledby="needs">
        <h2 id="needs">Needs your attention ({flagged.length})</h2>
        {flagged.length === 0 ? <p className="muted">Nothing needs you right now.</p> : flagged.map(p => (
          <div key={p.id} className="stack">
            <Link href={`/dietitian/patients/${p.id}`} style={{ fontWeight: 700 }}>{p.code}</Link>
            {p.flags.map((f, i) => <p key={i} className={`flag ${f.kind === "data_gap" ? "gap" : ""}`}>{f.text}</p>)}
          </div>
        ))}
      </section>

      <section className="card" aria-labelledby="all">
        <h2 id="all">All patients</h2>
        <div className="scroll">
          <table>
            <thead><tr><th>Code</th><th>Status</th><th>Current change</th><th>This week, days with kopi or teh</th><th></th></tr></thead>
            <tbody>
              {patients.map(p => (
                <tr key={p.id}>
                  <td>{p.code}</td>
                  <td>{p.status}</td>
                  <td>{p.option ?? "—"}</td>
                  <td>{p.adherence.opportunity ? `${p.adherence.followed} of ${p.adherence.opportunity} followed` : "—"}</td>
                  <td><Link href={`/dietitian/patients/${p.id}`}>Summary</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <EnrolForm action={enrol} />
      {actor.role === "admin" && <Link className="btn ghost" href="/dietitian/metrics">Study metrics and export</Link>}
    </main>
  );
}
