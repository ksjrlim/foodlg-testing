"use client";
import { useActionState } from "react";
import { OPTIONS } from "@/lib/domain";

type Result = { ok: boolean; code?: string; invitePath?: string; error?: string } | undefined;

export function EnrolForm({ action }: { action: (s: unknown, f: FormData) => Promise<Result> }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="card">
      <h2>Enrol a patient</h2>
      <p className="muted small">Goal: reduce added sugar from drinks. Use a study code only, never a name or NRIC.</p>
      <label className="field" htmlFor="code">Patient code
        <input id="code" name="code" type="text" placeholder="P-0004" required pattern="[A-Za-z]-\d{4}" />
      </label>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <legend className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Options pre-approved for this patient</legend>
        {OPTIONS.map(o => (
          <label key={o.id} className="small" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" name="preapproved" value={o.id} defaultChecked={o.step === "smaller"} />
            <span><b>{o.from_item} → {o.name}</b><br /><span className="muted">{o.display_claim}</span></span>
          </label>
        ))}
      </fieldset>
      <label className="field" htmlFor="review">Next review date
        <input id="review" name="review" type="text" placeholder="YYYY-MM-DD (default: 2 weeks)" pattern="\d{4}-\d{2}-\d{2}" />
      </label>
      <label className="small" style={{ display: "flex", gap: 8, fontWeight: 600 }}>
        <input type="checkbox" name="inclusion" value="yes" required /> Patient meets the study inclusion criteria and has agreed this goal with me
      </label>
      {state?.error && <p className="error" role="alert">{state.error}</p>}
      {state?.ok && (
        <div className="goal" role="status">
          <b>Enrolled {state.code}</b>
          Give the patient this invite link (single use): <code style={{ wordBreak: "break-all" }}>{state.invitePath}</code>
        </div>
      )}
      <button className="primary" type="submit" disabled={pending}>{pending ? "Enrolling…" : "Enrol and create invite"}</button>
    </form>
  );
}
