declare module "@/lib/schema.generated.mjs" { const sql: string; export default sql; }
declare module "@/lib/seed.mjs" {
  import type { Client } from "pg";
  export const DEMO_PASSWORD: string; export const DEMO_PASSCODE: string;
  export function seed(db: Client): Promise<{ invitePath: string; accounts: string[] }>;
}
