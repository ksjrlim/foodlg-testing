// Session cookie helpers for server components and actions. Signing lives in session-core.
import { cookies } from "next/headers";
import type { Actor } from "./db-types";
import { encode, decode, IDLE_MS } from "./session-core";

const COOKIE = "foodlg_session";

export { encode, decode };

export async function getActor(): Promise<Actor | null> {
  const jar = await cookies();
  return decode(jar.get(COOKIE)?.value);
}

export async function setActor(actor: Actor) {
  const jar = await cookies();
  jar.set(COOKIE, encode(actor), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: IDLE_MS / 1000 });
}

export async function clearActor() {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export { newToken, hashToken } from "./tokens";
