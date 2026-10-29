import { serviceClient } from "../_shared/auth.ts";
import { hasCronSecret } from "../_shared/cron.ts";
import { getLnd, transitionStore } from "../_shared/deps.ts";
import { createHandler, type PendingPayment } from "./handler.ts";

Deno.serve(createHandler({
  ...transitionStore,
  isAuthorized: (req) => hasCronSecret(req),
  async listPending(limit) {
    const { data, error } = await serviceClient()
      .from("payments")
      .select("payment_hash, expires_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []) as PendingPayment[];
  },
  lookupInvoice: (hash) => getLnd().lookupInvoice(hash),
}));
