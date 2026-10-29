import { preflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";

export interface SettlementDeps {
  isCron(req: Request): boolean;
  // Service path (external scheduler): generate_daily_invoices.
  runAsService(cycleDate: string | null): Promise<number>;
  // Admin "Run now": admin_run_daily_settlement as the caller (audited). Throws HttpError.
  runAsAdmin(req: Request, cycleDate: string | null): Promise<number>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST { cycle_date?: "YYYY-MM-DD" }. Omitted = the most recently completed 19:00 Dhaka cycle.
// pg_cron normally runs the SQL directly; this endpoint serves admins and external schedulers.
export function createHandler(deps: SettlementDeps) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      const body = await readJson<{ cycle_date?: unknown }>(req).catch(() => ({} as { cycle_date?: unknown }));
      const cycleDate = typeof body.cycle_date === "string" && body.cycle_date ? body.cycle_date : null;
      if (cycleDate !== null && !DATE_RE.test(cycleDate)) throw new HttpError(400, "invalid_cycle_date");

      const rows = deps.isCron(req)
        ? await deps.runAsService(cycleDate)
        : await deps.runAsAdmin(req, cycleDate);
      return json({ cycle_date: cycleDate, rows });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
