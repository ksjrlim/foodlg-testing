"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Actor } from "./db";
import { getActor } from "./session";
import type { Answers } from "./domain";
import * as svc from "./services/patient";

export async function requirePatient(): Promise<Actor> {
  const a = await getActor();
  if (!a || a.role !== "patient") redirect("/patient/login");
  return a;
}

export async function loadPatientState(actor: Actor) { return svc.loadPatientState(actor); }

const done = (q = "") => { revalidatePath("/patient"); redirect("/patient" + q); };

export async function saveChoice(form: FormData) {
  const actor = await requirePatient();
  const s = await svc.loadPatientState(actor);
  const answers: Record<string, Answers> = {};
  for (const id of (s.plan?.preapproved_option_ids ?? []) as string[]) {
    answers[id] = {
      stall: (form.get(`${id}.stall`) as Answers["stall"]) ?? "unsure",
      control: (form.get(`${id}.control`) as Answers["control"]) ?? "yes",
      taste: Number(form.get(`${id}.taste`) ?? 2),
      confidence: Number(form.get(`${id}.confidence`) ?? 6)
    };
  }
  await svc.chooseChange(actor, { chosen: String(form.get("chosen") ?? ""), answers });
  done();
}

export async function checkIn(form: FormData) {
  const actor = await requirePatient();
  const outcome = String(form.get("outcome"));
  const context = (form.get("context") as string) || null;
  if (outcome === "not_followed") redirect(`/patient/adapt${context ? `?context=${encodeURIComponent(context)}` : ""}`);
  if (outcome !== "followed" && outcome !== "no_opportunity") throw new Error("Invalid outcome");
  await svc.recordCheckin(actor, { outcome, context });
  done();
}

export async function applyBarrier(form: FormData) {
  const actor = await requirePatient();
  await svc.recordBarrier(actor, { barrierId: String(form.get("barrier")), accept: form.get("accept") === "yes", context: (form.get("context") as string) || null });
  done("?saved=1");
}

export async function reviewCycle(form: FormData) {
  const actor = await requirePatient();
  const outcome = String(form.get("outcome"));
  if (outcome !== "continue" && outcome !== "smaller_step" && outcome !== "next_change") throw new Error("Invalid outcome");
  await svc.closeCycle(actor, outcome);
  done();
}

export async function answerFollowUp(form: FormData) {
  const actor = await requirePatient();
  await svc.recordFollowUp(actor, Number(form.get("week")), String(form.get("frequency")));
  done();
}

export async function setReminder(form: FormData) {
  const actor = await requirePatient();
  await svc.updateReminder(actor, String(form.get("time") ?? "") || null);
  done();
}
