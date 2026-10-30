// POST { slug, amount_usd, hostname } -> { payment_id, bolt11, amount_usd, amount_sats, expires_at }
import { serviceClient } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/deps.ts";
import { issueDeps } from "../_shared/invoice_deps.ts";
import { loadSettings } from "../_shared/settings.ts";
import { createHandler } from "./handler.ts";

Deno.serve(createHandler({
  ...issueDeps,
  rateLimit,
  async limits() {
    const s = await loadSettings(serviceClient());
    return { perIp: s.rateLimitIpPerMin, perLink: s.rateLimitLinkPerMin };
  },
  ipSalt: Deno.env.get("IP_HASH_SALT") ?? "",
}));
