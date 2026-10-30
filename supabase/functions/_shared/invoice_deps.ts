// Production wiring for issueInvoice(): SQL RPCs, the shared BTC/USD cache and LND.
import { serviceClient } from "./auth.ts";
import { brandName, getLnd, rpc } from "./deps.ts";
import { HttpError } from "./http.ts";
import type { IssueDeps } from "./invoice.ts";
import { cachedRate, fetchBtcUsd, type RateQuote } from "./rate.ts";

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

export const issueDeps: IssueDeps = {
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
      p_memo: r.memo,
      p_issued_by: r.issuedBy,
    }),
  btcUsd: async () => (await btcUsd()).rate,
  addInvoice: (input) => getLnd().addInvoice(input),
  brandName: brandName(),
};
