"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Actor } from "./db";
import { getActor } from "./session";
import * as svc from "./services/dietitian";

export async function requireDietitian(): Promise<Actor> {
  const a = await getActor();
  if (!a || (a.role !== "dietitian" && a.role !== "admin")) redirect("/login");
  return a;
}

export async function enrol(_: unknown, form: FormData) {
  const actor = await requireDietitian();
  try {
    const r = await svc.enrolPatient(actor, {
      code: String(form.get("code") ?? ""),
      preapproved: form.getAll("preapproved").map(String),
      reviewDate: (form.get("review") as string) || null,
      inclusionConfirmed: form.get("inclusion") === "yes"
    });
    revalidatePath("/dietitian");
    return { ok: true, code: r.code, invitePath: r.invitePath };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not enrol";
    return { ok: false, error: /duplicate key/.test(msg) ? "That patient code is already in use." : msg };
  }
}

export async function decide(form: FormData) {
  const actor = await requireDietitian();
  const id = String(form.get("request"));
  const decision = form.get("decision") === "approved" ? "approved" : "held";
  await svc.decideRequest(actor, id, decision);
  revalidatePath(`/dietitian/patients/${form.get("patient")}`);
  redirect(`/dietitian/patients/${form.get("patient")}`);
}

export async function savePreapproved(form: FormData) {
  const actor = await requireDietitian();
  const pid = String(form.get("patient"));
  await svc.updatePreapproved(actor, pid, form.getAll("preapproved").map(String));
  revalidatePath(`/dietitian/patients/${pid}`);
  redirect(`/dietitian/patients/${pid}`);
}
