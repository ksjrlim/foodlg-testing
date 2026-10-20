import { getActor } from "@/lib/session";
import { exportCsv, EXPORT_TABLES, type ExportTable } from "@/lib/services/metrics";

export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor || actor.role !== "admin") return new Response("Not allowed", { status: 403 });
  const url = new URL(req.url);
  const table = url.searchParams.get("table") as ExportTable;
  const mode = url.searchParams.get("mode") === "real" ? "real" : "synthetic";
  if (!EXPORT_TABLES.includes(table)) return new Response("Unknown table", { status: 400 });
  const csv = await exportCsv(actor, table, mode);
  return new Response(csv, { headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="foodlg-${mode}-${table}.csv"`,
    "Cache-Control": "no-store"
  } });
}
