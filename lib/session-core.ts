// Pure session signing, shared by server code and middleware.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Actor } from "./db-types";

export const IDLE_MS = 30 * 60 * 1000;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ characters)");
  return s;
}
const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function encode(actor: Actor, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ ...actor, exp: now + IDLE_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decode(token: string | undefined, now = Date.now()): Actor | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof d.exp !== "number" || d.exp < now) return null;
    if (!["dietitian", "patient", "admin"].includes(d.role)) return null;
    if (typeof d.id !== "string") return null;
    return { role: d.role, id: d.id };
  } catch { return null; }
}
