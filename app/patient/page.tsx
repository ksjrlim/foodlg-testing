import Link from "next/link";
import { Top } from "@/components/Top";
import { Week, Legend } from "@/components/Week";
import { requirePatient, loadPatientState, checkIn, reviewCycle, answerFollowUp, setReminder } from "@/lib/patient";
import { adherence, optionById } from "@/lib/domain";

export const dynamic = "force-dynamic";

export default async function PatientHome({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const actor = await requirePatient();
  const s = await loadPatientState(actor);
  const sp = await searchParams;
  const pendingRequests = s.requests.filter(r => r.status === "awaiting").length;
  const adh = adherence(s.checkins);

  return (
    <main className="shell narrow">
      <Top label={`Patient ${s.patient.code}`} signedIn />
      {s.plan && (
        <div className="goal"><b>Goal agreed with your dietitian</b>{s.plan.goal}{s.plan.review_date && <> · next review {s.plan.review_date}</>}</div>
      )}
      {sp.saved && <p className="goal" role="status">Saved. Thanks for letting us know.</p>}
      {pendingRequests > 0 && <p className="small muted">Your dietitian has {pendingRequests} request{pendingRequests > 1 ? "s" : ""} from you to look at. Nothing changes until they agree.</p>}

      {s.phase === "no_plan" && <div className="card"><h2>No goal set yet</h2><p>Your dietitian will set up your goal with you at your next visit.</p></div>}

      {s.phase === "choose" && (
        <div className="card">
          <h2>Pick the change that fits your life</h2>
          <p className="muted">Your dietitian has agreed some options with you. Answer a few quick questions and FoodLG will put the most workable one first.</p>
          <Link className="btn primary" href="/patient/choose">Choose my change</Link>
        </div>
      )}

      {s.phase === "followup" && s.dueWeek && (
        <form action={answerFollowUp} className="card">
          <input type="hidden" name="week" value={s.dueWeek} />
          <h2>A quick question ({s.dueWeek}-week check)</h2>
          <p>In the past week, on days you had kopi or teh, how often was it your chosen drink?</p>
          <div className="stack">
            {[["every", "Every time"], ["most", "Most days"], ["some", "Some days"], ["never", "Never"]].map(([v, l]) => (
              <button key={v} className="choice" type="submit" name="frequency" value={v}>{l}</button>
            ))}
          </div>
        </form>
      )}

      {(s.phase === "checkin" || s.phase === "done_today" || s.phase === "starts_tomorrow" || s.phase === "review") && s.current && s.option && (
        <div className="card">
          <div className="row"><h2>My 7 days: {s.option.name}</h2></div>
          <p className="muted small">{adh.followed} of {adh.opportunity} days with kopi or teh{adh.noOpportunity ? ` · ${adh.noOpportunity} day${adh.noOpportunity > 1 ? "s" : ""} without` : ""}</p>
          <Week days={s.days} checkins={s.checkins} today={s.today} />
          <Legend />
        </div>
      )}

      {s.phase === "starts_tomorrow" && s.option && (
        <div className="card"><h2>Your new change starts tomorrow</h2><p>From tomorrow you'll be trying <b>{s.option.name}</b>.</p></div>
      )}

      {s.phase === "checkin" && s.option && (
        <form action={checkIn} className="card">
          <h2>Today</h2>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small muted" style={{ marginBottom: 6 }}>Where were you? (optional)</legend>
            <div className="seg">
              {[["alone", "Alone"], ["family", "Family"], ["colleagues", "Colleagues"], ["ordered_for_me", "Someone ordered"]].map(([v, l]) => (
                <label key={v}><input type="radio" name="context" value={v} /><span>{l}</span></label>
              ))}
            </div>
          </fieldset>
          <div className="stack">
            <button className="choice" type="submit" name="outcome" value="followed">Yes, I had {s.option.name.toLowerCase()}</button>
            <button className="choice" type="submit" name="outcome" value="not_followed">I had my usual drink instead</button>
            <button className="choice" type="submit" name="outcome" value="no_opportunity">I didn't have kopi or teh today</button>
          </div>
        </form>
      )}

      {s.phase === "done_today" && <div className="card"><h2>All done for today</h2><p className="muted">See you tomorrow.</p></div>}

      {s.phase === "review" && s.option && (() => {
        const smaller = (s.plan.preapproved_option_ids as string[]).map(optionById).find(o => o && o.from_item === s.option!.from_item && o.step === "smaller" && o.id !== s.option!.id);
        return (
          <form action={reviewCycle} className="card">
            <h2>Your week is done</h2>
            <p>You had {s.option.name.toLowerCase()} on {adh.followed} of {adh.opportunity} days with kopi or teh. What next?</p>
            <div className="stack">
              <button className="choice" type="submit" name="outcome" value="continue">Keep going with {s.option.name} for another week</button>
              {smaller && <button className="choice" type="submit" name="outcome" value="smaller_step">Try a smaller step: {smaller.name}</button>}
              <button className="choice" type="submit" name="outcome" value="next_change">I'm ready for my next change (I'll agree it with my dietitian)</button>
            </div>
          </form>
        );
      })()}

      {s.plan && (
        <details className="card">
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Daily reminder</summary>
          <form action={setReminder} className="row">
            <label className="field" htmlFor="time" style={{ flex: 1 }}>Time
              <input id="time" type="time" name="time" defaultValue={s.patient.reminder_time?.slice(0, 5) ?? ""} />
            </label>
            <button className="ghost" type="submit">Save</button>
          </form>
          <p className="muted small">Leave empty for no reminder. (Reminders are recorded in this test version but not yet sent.)</p>
        </details>
      )}
      <p className="muted small">FoodLG doesn't watch your health in real time. For anything urgent, contact your clinic.</p>
    </main>
  );
}
