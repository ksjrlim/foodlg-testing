// Refreshes the session cookie on each request, so sessions expire after 30 minutes of inactivity.
import { NextResponse, type NextRequest } from "next/server";
import { decode, encode } from "./lib/session-core";

export const config = { runtime: "nodejs", matcher: ["/((?!_next/|favicon).*)"] };

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const actor = decode(req.cookies.get("foodlg_session")?.value);
  if (actor) {
    res.cookies.set("foodlg_session", encode(actor), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 60 });
  }
  return res;
}
