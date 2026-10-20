"use client";
import { useActionState } from "react";

type Field = { name: string; label: string; type?: string; inputMode?: "numeric" | "email" | "text"; autoComplete?: string; pattern?: string; maxLength?: number };

export function AuthForm({ action, fields, submit, hidden, children }: {
  action: (s: unknown, f: FormData) => Promise<{ error?: string } | void>;
  fields: Field[]; submit: string; hidden?: Record<string, string>; children?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="stack">
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {fields.map(f => (
        <label key={f.name} className="field" htmlFor={f.name}>{f.label}
          <input id={f.name} name={f.name} type={f.type ?? "text"} inputMode={f.inputMode} autoComplete={f.autoComplete} pattern={f.pattern} maxLength={f.maxLength} required />
        </label>
      ))}
      {children}
      {state && typeof state === "object" && state.error ? <p className="error" role="alert">{state.error}</p> : null}
      <button className="primary" type="submit" disabled={pending}>{pending ? "Please wait…" : submit}</button>
    </form>
  );
}
