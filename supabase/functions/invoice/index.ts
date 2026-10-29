import { serviceClient } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/deps.ts";
import { loadSettings } from "../_shared/settings.ts";
import { createHandler } from "./handler.ts";

Deno.serve(createHandler({
  async getInvoice(id) {
    const { data, error } = await serviceClient()
      .from("payments")
      .select("status, amount_usd, amount_sats, bolt11, expires_at, settled_at, memo, payment_links(slug, display_name)")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const link = data.payment_links as unknown as { slug: string; display_name: string } | null;
    return { ...data, slug: link?.slug ?? "", display_name: link?.display_name ?? "" };
  },
  rateLimit,
  limitPerMinute: async () => (await loadSettings(serviceClient())).rateLimitStatusPerMin,
  ipSalt: Deno.env.get("IP_HASH_SALT") ?? "",
}));
