// One path for creating a Lightning invoice, shared by the public checkout (create-invoice)
// and admin-issued invoices (admin-actions): validate in SQL, price at the cached rate,
// ask LND for a public 3600 s invoice, record it with the commission stamp.
import { HttpError } from "./http.ts";
import { type AddInvoiceResult, MAX_EXPIRY_SECONDS } from "./lnd.ts";
import { formatCents, usdCentsToSats } from "./money.ts";

export interface PreparedCheckout {
  linkId: string;
  displayName: string;
  expirySeconds: number;
}

export interface InvoiceRecord {
  linkId: string;
  amountUsd: string;
  amountSats: bigint;
  btcUsdRate: number;
  paymentHash: string;
  bolt11: string;
  expirySeconds: number;
  domain: string | null;
  memo: string | null;
  issuedBy: string | null;
}

export interface IssueDeps {
  // Validates link + amount against settings and link limits (SQL prepare_checkout). Throws HttpError.
  prepareCheckout(slug: string, amountUsd: string, hostname: string | null): Promise<PreparedCheckout>;
  recordInvoice(record: InvoiceRecord): Promise<string>;
  btcUsd(): Promise<number>;
  addInvoice(input: { valueSat: bigint; memo: string; expirySeconds: number }): Promise<AddInvoiceResult>;
  brandName: string;
  now?: () => Date;
}

export interface IssueInput {
  slug: string;
  cents: bigint;
  hostname: string | null;
  memo?: string | null;
  issuedBy?: string | null;
  // Runs after SQL validation, before LND is called (e.g. the per-link rate limit).
  afterPrepare?: (prepared: PreparedCheckout) => Promise<void>;
}

export interface IssuedInvoice {
  payment_id: string;
  bolt11: string;
  amount_usd: string;
  amount_sats: number;
  expires_at: string;
}

export async function issueInvoice(deps: IssueDeps, input: IssueInput): Promise<IssuedInvoice> {
  const amountUsd = formatCents(input.cents);
  const prepared = await deps.prepareCheckout(input.slug, amountUsd, input.hostname);
  await input.afterPrepare?.(prepared);

  let rate: number;
  try {
    rate = await deps.btcUsd();
  } catch {
    throw new HttpError(503, "rate_unavailable");
  }
  const sats = usdCentsToSats(input.cents, rate);
  const expirySeconds = Math.min(MAX_EXPIRY_SECONDS, prepared.expirySeconds);
  const memo = input.memo?.trim() || null;

  let invoice: AddInvoiceResult;
  try {
    invoice = await deps.addInvoice({
      valueSat: sats,
      memo: `${deps.brandName}: ${memo ?? prepared.displayName}`,
      expirySeconds,
    });
  } catch (err) {
    console.error("addInvoice failed:", err instanceof Error ? err.message : String(err));
    throw new HttpError(502, "lightning_unavailable");
  }

  const paymentId = await deps.recordInvoice({
    linkId: prepared.linkId,
    amountUsd,
    amountSats: sats,
    btcUsdRate: rate,
    paymentHash: invoice.paymentHash,
    bolt11: invoice.paymentRequest,
    expirySeconds,
    domain: input.hostname,
    memo,
    issuedBy: input.issuedBy ?? null,
  });

  const now = deps.now?.() ?? new Date();
  return {
    payment_id: paymentId,
    bolt11: invoice.paymentRequest,
    amount_usd: amountUsd,
    amount_sats: Number(sats),
    expires_at: new Date(now.getTime() + expirySeconds * 1000).toISOString(),
  };
}
