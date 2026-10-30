// Minimal LND REST client for the operator's own node, reached through a Cloudflare Tunnel
// protected by Cloudflare Access service-token headers. Authenticates with an
// invoice-only macaroon (invoices:read invoices:write info:read offchain:read).
// Never log headers: they carry the macaroon and the Access secret.

export interface LndConfig {
  restUrl: string;
  macaroonHex: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  timeoutMs?: number;
}

export type InvoiceState = "OPEN" | "SETTLED" | "CANCELED" | "ACCEPTED";

export interface AddInvoiceResult {
  paymentHash: string; // hex
  paymentRequest: string; // bolt11
  addIndex: string;
}

export interface LookupResult {
  state: InvoiceState;
  settleDate: Date | null;
  amtPaidSat: number;
}

export class LndError extends Error {
  constructor(message: string, readonly status?: number, readonly detail?: string) {
    super(message);
  }

  get notFound(): boolean {
    return this.status === 404 || /unable to locate invoice|not found/i.test(this.detail ?? "");
  }
}

export const MAX_EXPIRY_SECONDS = 3600;

export function base64ToHex(b64: string): string {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

export function hexToBase64(hex: string): string {
  const bytes = hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? [];
  return btoa(String.fromCharCode(...bytes));
}

export class LndClient {
  readonly #base: string;
  readonly #cfg: LndConfig;
  readonly #fetch: typeof fetch;

  constructor(cfg: LndConfig, fetchImpl: typeof fetch = fetch) {
    const url = new URL(cfg.restUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new LndError("LND_REST_URL must use https");
    }
    if (!/^[0-9a-f]+$/i.test(cfg.macaroonHex)) {
      throw new LndError("LND macaroon must be hex encoded");
    }
    this.#base = url.origin;
    this.#cfg = cfg;
    this.#fetch = fetchImpl;
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Grpc-Metadata-macaroon": this.#cfg.macaroonHex,
      "Content-Type": "application/json",
    };
    if (this.#cfg.cfAccessClientId && this.#cfg.cfAccessClientSecret) {
      h["CF-Access-Client-Id"] = this.#cfg.cfAccessClientId;
      h["CF-Access-Client-Secret"] = this.#cfg.cfAccessClientSecret;
    }
    return h;
  }

  // deno-lint-ignore no-explicit-any
  async #request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.#fetch(this.#base + path, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      // Cloudflare Access answers an unauthenticated call with a redirect to its login page.
      redirect: "manual",
      signal: AbortSignal.timeout(this.#cfg.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = "";
      try {
        detail = String(JSON.parse(text)?.message ?? "");
      } catch {
        // non-JSON error page (tunnel / Access); keep detail empty
      }
      throw new LndError(`LND ${method} ${path.split("?")[0]} failed with ${res.status}`, res.status, detail);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new LndError(`LND ${method} returned non-JSON`, res.status);
    }
  }

  // private:false -> no route hints; the node is public with public, inbound-liquid channels.
  async addInvoice(input: { valueSat: bigint | number; memo: string; expirySeconds: number }): Promise<AddInvoiceResult> {
    const value = Number(input.valueSat);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new LndError("invoice value must be a positive integer of sats");
    }
    const expiry = Math.min(MAX_EXPIRY_SECONDS, Math.max(60, Math.floor(input.expirySeconds)));
    const r = await this.#request("POST", "/v1/invoices", {
      value,
      memo: input.memo.slice(0, 120),
      expiry: String(expiry),
      private: false,
    });
    if (typeof r?.r_hash !== "string" || typeof r?.payment_request !== "string") {
      throw new LndError("unexpected AddInvoice response");
    }
    return { paymentHash: base64ToHex(r.r_hash), paymentRequest: r.payment_request, addIndex: String(r.add_index ?? "") };
  }

  // Returns null when LND does not know the invoice.
  async lookupInvoice(paymentHashHex: string): Promise<LookupResult | null> {
    if (!/^[0-9a-f]{64}$/.test(paymentHashHex)) {
      throw new LndError("payment hash must be 64 lowercase hex chars");
    }
    try {
      const r = await this.#request("GET", `/v1/invoice/${paymentHashHex}`);
      const settleSeconds = Number(r?.settle_date ?? 0);
      return {
        state: (r?.state ?? "OPEN") as InvoiceState,
        settleDate: settleSeconds > 0 ? new Date(settleSeconds * 1000) : null,
        amtPaidSat: Number(r?.amt_paid_sat ?? 0),
      };
    } catch (err) {
      if (err instanceof LndError && err.notFound) return null;
      throw err;
    }
  }

  // Cancels an OPEN invoice (invoicesrpc.CancelInvoice; needs invoices:write).
  async cancelInvoice(paymentHashHex: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(paymentHashHex)) {
      throw new LndError("payment hash must be 64 lowercase hex chars");
    }
    await this.#request("POST", "/v2/invoices/cancel", { payment_hash: hexToBase64(paymentHashHex) });
  }

  // deno-lint-ignore no-explicit-any
  getInfo(): Promise<any> {
    return this.#request("GET", "/v1/getinfo");
  }

  // deno-lint-ignore no-explicit-any
  channelBalance(): Promise<any> {
    return this.#request("GET", "/v1/balance/channels");
  }
}

export function lndFromEnv(fetchImpl: typeof fetch = fetch): LndClient {
  const restUrl = Deno.env.get("LND_REST_URL");
  const macaroonHex = Deno.env.get("LND_INVOICE_MACAROON_HEX");
  if (!restUrl || !macaroonHex) {
    throw new LndError("LND_REST_URL / LND_INVOICE_MACAROON_HEX are not configured");
  }
  return new LndClient(
    {
      restUrl,
      macaroonHex,
      cfAccessClientId: Deno.env.get("CF_ACCESS_CLIENT_ID"),
      cfAccessClientSecret: Deno.env.get("CF_ACCESS_CLIENT_SECRET"),
    },
    fetchImpl,
  );
}
