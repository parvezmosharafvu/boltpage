import { ipHashSalt, serviceClient } from "../_shared/auth.ts";
import { getLnd, rateLimit, transitionStore } from "../_shared/deps.ts";
import { loadSettings } from "../_shared/settings.ts";
import { createHandler, type PaymentRow } from "./handler.ts";

Deno.serve(createHandler({
  ...transitionStore,
  async getPayment(id) {
    const { data, error } = await serviceClient()
      .from("payments")
      .select("id, status, amount_usd, settled_at, payment_hash, expires_at, last_checked_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as PaymentRow | null;
  },
  async markChecked(id) {
    await serviceClient().from("payments").update({ last_checked_at: new Date().toISOString() }).eq("id", id);
  },
  lookupInvoice: (hash) => getLnd().lookupInvoice(hash),
  rateLimit,
  limitPerMinute: async () => (await loadSettings(serviceClient())).rateLimitStatusPerMin,
  ipSalt: ipHashSalt(),
}));
