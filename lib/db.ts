// Database access. Every query runs inside a transaction that first switches to the non-login
// role foodlg_app (row-level security always applies) and sets the actor. There is no unscoped path.
import { Pool, PoolClient, types } from "pg";
import { RULE_VERSION } from "./domain";
import type { Actor } from "./db-types";

export type { Actor } from "./db-types";

// Return SQL dates as "YYYY-MM-DD" strings, never as time-zone-shifted Date objects.
types.setTypeParser(1082, (v: string) => v);

const g = globalThis as unknown as { __pool?: Pool };

export function connectionString() {
  // Vercel Marketplace integrations (Neon, Supabase) expose one of these.
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

function pool() {
  if (!g.__pool) g.__pool = new Pool({ connectionString: connectionString(), max: 5 });
  return g.__pool;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function scoped<T>(role: string, id: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    await client.query("set local role foodlg_app");
    await client.query("set local search_path = foodlg");
    await client.query("select set_config('app.actor_role', $1, true), set_config('app.actor_id', $2, true), set_config('app.rule_version', $3, true)",
      [role, id, RULE_VERSION]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function withActor<T>(actor: Actor, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  if (!UUID.test(actor.id)) throw new Error("invalid actor id");
  return scoped(actor.role, actor.id, fn);
}

/** Sign-in only: the 'auth' actor can read credentials and redeem invites, nothing else. */
export function withAuth<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  return scoped("auth", "", fn);
}

export const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // Singapore date
