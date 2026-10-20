import { redirect } from "next/navigation";
import { Top } from "@/components/Top";
import { ChooseForm } from "@/components/ChooseForm";
import { requirePatient, loadPatientState, saveChoice } from "@/lib/patient";

export const dynamic = "force-dynamic";

export default async function Choose() {
  const actor = await requirePatient();
  const s = await loadPatientState(actor);
  if (s.phase !== "choose") redirect("/patient");
  return (
    <main className="shell narrow">
      <Top label={`Patient ${s.patient.code}`} signedIn />
      <div className="goal"><b>Goal agreed with your dietitian</b>{s.plan.goal}</div>
      <h1>Which change fits your life?</h1>
      <p className="muted">The list re-orders as you answer: what's possible first, then what helps most, then what you'd find easiest.</p>
      <ChooseForm preapproved={s.plan.preapproved_option_ids} action={saveChoice} />
    </main>
  );
}
