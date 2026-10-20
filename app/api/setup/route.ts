// One-time setup for a hosted database: creates the schema and loads SYNTHETIC data.
// Requires the SETUP_TOKEN environment variable and a matching header. Remove SETUP_TOKEN after use.
import pg from "pg";
import { timingSafeEqual } from "node:crypto";
import schemaSql from "@/lib/schema.generated.mjs";
import { seed } from "@/lib/seed.mjs";
import { connectionString } from "@/lib/db";

export const dynamic = "force-dynamic";

function tokenOk(given: string | null) {
  const expected = process.env.SETUP_TOKEN;
  if (!expected || expected.length < 24 || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!tokenOk(req.headers.get("x-setup-token"))) return Response.json({ error: "Not allowed" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const db = new pg.Client({ connectionString: connectionString() });
  await db.connect();
  try {
    const exists = (await db.query("select 1 from information_schema.schemata where schema_name = 'foodlg'")).rows.length > 0;
    if (exists && body.reset !== true) return Response.json({ error: "Schema already exists. Send {\"reset\": true} to recreate it with synthetic data." }, { status: 409 });
    if (exists) {
      const real = await db.query("select count(*)::int n from foodlg.clinics where not is_synthetic").catch(() => ({ rows: [{ n: 0 }] }));
      if (real.rows[0].n > 0) return Response.json({ error: "Refusing to reset: real (non-synthetic) clinics exist." }, { status: 409 });
    }
    await db.query(schemaSql);
    const r = await seed(db);
    return Response.json({ ok: true, synthetic: true, invitePath: r.invitePath, accounts: r.accounts });
  } finally {
    await db.end();
  }
}

// TEMPORARY: GET form used once for initial hosted setup; removed afterwards.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const h = new Headers({ "x-setup-token": u.searchParams.get("token") ?? "", "content-type": "application/json" });
  return POST(new Request(req.url, { method: "POST", headers: h, body: JSON.stringify({ reset: u.searchParams.get("reset") === "1" }) }));
}
