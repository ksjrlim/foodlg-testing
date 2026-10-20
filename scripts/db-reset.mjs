// Resets the LOCAL database and loads synthetic data. Never run against a hosted database.
// Usage: npm run db:reset
import { readFileSync } from "node:fs";
import pg from "pg";
import { seed, DEMO_PASSWORD, DEMO_PASSCODE } from "../lib/seed.mjs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const url = process.env.ADMIN_DATABASE_URL;
if (!url) throw new Error("ADMIN_DATABASE_URL not set");
if (!/localhost|127\.0\.0\.1|host=\/tmp/.test(url)) throw new Error("Refusing to reset a non-local database");

const db = new pg.Client({ connectionString: url });
await db.connect();
await db.query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
const r = await seed(db);
await db.end();
console.log(`Synthetic data loaded.
  Dietitian A: dietitian.a@example.test / ${DEMO_PASSWORD}   (patients P-0001, P-0002, P-0003)
  Dietitian B: dietitian.b@example.test / ${DEMO_PASSWORD}   (patient P-0101)
  Admin:       admin@example.test / ${DEMO_PASSWORD}
  Patients P-0001, P-0002, P-0101: passcode ${DEMO_PASSCODE}
  Invite link for P-0003: ${r.invitePath}`);
