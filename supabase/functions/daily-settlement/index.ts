import { requireAdmin } from "../_shared/auth.ts";
import { isCronRequest, rpc } from "../_shared/deps.ts";
import { dbError } from "../_shared/http.ts";
import { createHandler } from "./handler.ts";

Deno.serve(createHandler({
  isCron: isCronRequest,
  runAsService: (cycleDate) => rpc<number>("generate_daily_invoices", { p_cycle_date: cycleDate }),
  async runAsAdmin(req, cycleDate) {
    const admin = await requireAdmin(req);
    const { data, error } = await admin.client.rpc("admin_run_daily_settlement", { p_cycle_date: cycleDate });
    if (error) throw dbError(error);
    return data as number;
  },
}));
