import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import pg from "pg";
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
export function resetDb() { execSync("node scripts/db-reset.mjs", { stdio: "ignore" }); }
export async function admin<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL }); await c.connect();
  try { return (await c.query(sql, params)).rows as T[]; } finally { await c.end(); }
}
export const idOf = async (code: string) => (await admin("select id from foodlg.patients where code = $1", [code]))[0].id as string;
export const dietitianId = async (email: string) => (await admin("select id from foodlg.dietitians where email = $1", [email]))[0].id as string;
