const LABEL: Record<string, string> = { followed: "Done", not_followed: "Usual", no_opportunity: "None" };

export function Week({ days, checkins, today }: { days: string[]; checkins: { day: string; outcome: string }[]; today: string }) {
  return (
    <div className="week" aria-label="This week">
      {days.map((d, i) => {
        const c = checkins.find(k => k.day === d);
        const cls = c ? `d-${c.outcome}` : d < today ? "d-gap" : "";
        const text = c ? LABEL[c.outcome] : d < today ? "No entry" : d === today ? "Today" : "";
        return (
          <div key={d} className={`day ${cls} ${d === today ? "d-today" : ""}`}>
            <span>Day</span><b>{i + 1}</b><span>{text}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Legend() {
  return (
    <p className="muted small">Done: had your chosen drink · Usual: had your usual drink · None: no kopi or teh that day · No entry: nothing recorded</p>
  );
}
