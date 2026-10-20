"use client";
import { useMemo, useState } from "react";
import { OPTIONS, rankOptions, type Answers } from "@/lib/domain";

const DEFAULT: Answers = { stall: "yes", control: "yes", taste: 2, confidence: 6 };

function Seg({ name, value, options, onChange, legend }: {
  name: string; value: string | number; options: [string | number, string][]; onChange: (v: string) => void; legend: string;
}) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="small" style={{ marginBottom: 4 }}>{legend}</legend>
      <div className="seg">
        {options.map(([v, label]) => (
          <label key={String(v)}>
            <input type="radio" name={name} value={String(v)} checked={String(value) === String(v)} onChange={e => onChange(e.target.value)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ChooseForm({ preapproved, action }: { preapproved: string[]; action: (f: FormData) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, Answers>>(() =>
    Object.fromEntries(preapproved.map(id => [id, { ...DEFAULT }])));
  const ranked = useMemo(() => rankOptions(preapproved, answers), [preapproved, answers]);
  const firstFeasible = ranked.find(r => r.status === "feasible")?.option.id ?? "";
  const [chosen, setChosen] = useState<string>("");
  const pick = chosen && ranked.some(r => r.option.id === chosen && r.status === "feasible") ? chosen : firstFeasible;
  const set = (id: string, k: keyof Answers, v: string) =>
    setAnswers(a => ({ ...a, [id]: { ...a[id], [k]: k === "taste" || k === "confidence" ? Number(v) : v } as Answers }));

  return (
    <form action={action} className="stack">
      <input type="hidden" name="chosen" value={pick} />
      {ranked.map((r, i) => {
        const a = answers[r.option.id];
        return (
          <div key={r.option.id} className="card" style={r.option.id === pick ? { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" } : r.status !== "feasible" ? { opacity: .7 } : undefined}>
            <div className="row">
              <h3>{r.status === "feasible" ? `${i + 1}. ` : ""}{r.option.from_item} → {r.option.name}</h3>
              {r.status === "feasible" ? <span className="tag t-good">Possible</span> : <span className="tag t-warn">Not possible now</span>}
            </div>
            <p className="claim">{r.option.display_claim}{r.option.display_note && <> <span className="note">{r.option.display_note}</span></>}</p>
            <div className="q">
              <Seg legend="Can you get this at your usual stall?" name={`${r.option.id}.stall`} value={a.stall} onChange={v => set(r.option.id, "stall", v)} options={[["yes", "Yes"], ["unsure", "Not sure"], ["no", "No"]]} />
              <Seg legend="Can you stick to it when eating with others?" name={`${r.option.id}.control`} value={a.control} onChange={v => set(r.option.id, "control", v)} options={[["yes", "Yes"], ["no", "No"]]} />
              <Seg legend="How acceptable is the taste?" name={`${r.option.id}.taste`} value={a.taste} onChange={v => set(r.option.id, "taste", v)} options={[[1, "Hard"], [2, "OK"], [3, "Easy"]]} />
              <Seg legend="How sure are you that you can do it most days?" name={`${r.option.id}.confidence`} value={a.confidence} onChange={v => set(r.option.id, "confidence", v)} options={[[3, "Not sure"], [6, "Fairly sure"], [9, "Very sure"]]} />
            </div>
            {r.reasons.length > 0 && <p className="muted small">{r.reasons.join(" · ")}</p>}
            {r.status === "feasible" && (
              <button type="button" className={r.option.id === pick ? "primary" : "ghost"} onClick={() => setChosen(r.option.id)} aria-pressed={r.option.id === pick}>
                {r.option.id === pick ? "This is my change" : "Choose this instead"}
              </button>
            )}
          </div>
        );
      })}
      <button className="primary" type="submit" disabled={!pick}>
        {pick ? `Start 7 days with ${OPTIONS.find(o => o.id === pick)?.name}` : "None of these is possible right now"}
      </button>
      {!pick && <p className="muted small">Tell your dietitian at your next visit, so you can agree a change that works for you.</p>}
    </form>
  );
}
