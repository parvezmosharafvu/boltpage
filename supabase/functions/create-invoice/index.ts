// POST { slug, amount_usd, hostname } -> { payment_id, bolt11, amount_usd, amount_sats, expires_at }
import { serviceClient } from "../_shared/auth.ts";
import { brandName, getLnd, rateLimit, rpc } from "../_shared/deps.ts";
import { HttpError } from "../_shared/http.ts";
import { cachedRate, fetchBtcUsd, type RateQuote } from "../_shared/rate.ts";
import { loadSettings } from "../_shared/settings.ts";
import { createHandler } from "./handler.ts";

const RATE_TTL_MS = 60_000;

// Shared cache in public.fx_rates so every isolate reuses one rate for <= 60 s.
async function loadRate(): Promise<RateQuote> {
  const db = serviceClient();
  const { data } = await db.from("fx_rates").select("rate, sources, fetched_at").eq("pair", "BTCUSD").maybeSingle();
  if (data) {
    const fetchedAt = new Date(data.fetched_at).getTime();
    if (Date.now() - fetchedAt < RATE_TTL_MS) {
      return { rate: Number(data.rate), sources: data.sources, fetchedAt };
    }
  }
  const quote = await fetchBtcUsd();
  await db.from("fx_rates").upsert({
    pair: "BTCUSD",
    rate: quote.rate,
    sources: quote.sources,
    fetched_at: new Date(quote.fetchedAt ?? Date.now()).toISOString(),
  });
  return quote;
}

const btcUsd = cachedRate(loadRate, RATE_TTL_MS);

Deno.serve(createHandler({
  async prepareCheckout(slug, amountUsd, hostname) {
    const rows = await rpc<{ link_id: string; display_name: string; expiry_seconds: number }[]>(
      "prepare_checkout",
      { p_slug: slug, p_amount_usd: amountUsd, p_hostname: hostname },
    );
    const row = rows?.[0];
    if (!row) throw new HttpError(404, "link_not_found");
    return { linkId: row.link_id, displayName: row.display_name, expirySeconds: Number(row.expiry_seconds) };
  },
  recordInvoice: (r) =>
    rpc<string>("record_invoice", {
      p_link_id: r.linkId,
      p_amount_usd: r.amountUsd,
      p_amount_sats: Number(r.amountSats),
      p_btc_usd_rate: r.btcUsdRate,
      p_payment_hash: r.paymentHash,
      p_bolt11: r.bolt11,
      p_expiry_seconds: r.expirySeconds,
      p_domain: r.domain,
    }),
  rateLimit,
  async limits() {
    const s = await loadSettings(serviceClient());
    return { perIp: s.rateLimitIpPerMin, perLink: s.rateLimitLinkPerMin };
  },
  btcUsd: async () => (await btcUsd()).rate,
  addInvoice: (input) => getLnd().addInvoice(input),
  ipSalt: Deno.env.get("IP_HASH_SALT") ?? "",
  brandName: brandName(),
}));
