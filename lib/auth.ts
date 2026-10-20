"use server";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { withAuth } from "./db";
import { setActor, clearActor, hashToken } from "./session";

const CONSENT_VERSION = "consent-v0.1-synthetic";

// Simple in-memory attempt limiter (per server instance). Production needs a shared store.
const attempts = new Map<string, { n: number; until: number }>();
function limited(key: string) {
  const a = attempts.get(key);
  return !!a && a.n >= 5 && a.until > Date.now();
}
function fail(key: string) {
  const a = attempts.get(key) ?? { n: 0, until: 0 };
  a.n++; a.until = Date.now() + 15 * 60 * 1000; attempts.set(key, a);
}
async function logAuth(action: string, role: string, id: string | null) {
  await withAuth(db => db.query("select log_auth($1, $2, $3)", [action, role, id]));
}

export async function dietitianSignIn(_: unknown, form: FormData) {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (limited(email)) return { error: "Too many attempts. Try again in 15 minutes." };
  const row = await withAuth(db => db.query("select id, role, password_hash from dietitians where email = $1", [email])).then(r => r.rows[0]);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) { fail(email); return { error: "That email and password don't match." }; }
  attempts.delete(email);
  await setActor({ role: row.role === "admin" ? "admin" : "dietitian", id: row.id });
  await logAuth("sign_in", row.role, row.id);
  redirect("/dietitian");
}

export async function patientSignIn(_: unknown, form: FormData) {
  const code = String(form.get("code") ?? "").trim().toUpperCase();
  const passcode = String(form.get("passcode") ?? "");
  if (limited(code)) return { error: "Too many attempts. Try again in 15 minutes." };
  const row = await withAuth(db => db.query("select id, passcode_hash, status from patients where code = $1", [code])).then(r => r.rows[0]);
  if (!row || row.status !== "active" || !row.passcode_hash || !bcrypt.compareSync(passcode, row.passcode_hash)) {
    fail(code); return { error: "That code and passcode don't match." };
  }
  attempts.delete(code);
  await setActor({ role: "patient", id: row.id });
  await logAuth("sign_in", "patient", row.id);
  redirect("/patient");
}

export async function redeemInvite(_: unknown, form: FormData) {
  const token = String(form.get("token") ?? "");
  const passcode = String(form.get("passcode") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  if (form.get("consent") !== "yes") return { error: "Please confirm you agree to take part before continuing." };
  if (!/^\d{6}$/.test(passcode)) return { error: "Choose a 6-digit passcode." };
  if (passcode !== confirm) return { error: "The two passcodes don't match." };
  const id = await withAuth(async db => {
    const r = await db.query("select id from patients where invite_token_hash = $1 and status = 'invited'", [hashToken(token)]);
    if (!r.rows[0]) return null;
    await db.query(`update patients set passcode_hash = $1, invite_token_hash = null, consent_version = $2, consent_at = now(), status = 'active' where id = $3`,
      [bcrypt.hashSync(passcode, 10), CONSENT_VERSION, r.rows[0].id]);
    return r.rows[0].id as string;
  });
  if (!id) return { error: "This invite link has already been used or is not valid. Ask your dietitian for a new one." };
  await setActor({ role: "patient", id });
  await logAuth("joined", "patient", id);
  redirect("/patient");
}

export async function signOut() {
  await clearActor();
  redirect("/");
}
