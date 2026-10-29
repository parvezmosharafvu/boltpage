// Acceptance 5: create-invoice against a mocked LND.
import { assertEquals } from "jsr:@std/assert@1";
import { type CreateInvoiceDeps, createHandler, type InvoiceRecord } from "../create-invoice/handler.ts";
import { HttpError } from "../_shared/http.ts";
import { LndClient } from "../_shared/lnd.ts";
import { HASH_A, hexToBase64, jsonResponse, mockFetch } from "./helpers.ts";

function setup(overrides: Partial<CreateInvoiceDeps> = {}) {
  const lndHttp = mockFetch(() => jsonResponse({ r_hash: hexToBase64(HASH_A), payment_request: "lnbc1ptestinvoice" }));
  const lnd = new LndClient(
    { restUrl: "https://lnd.example.test", macaroonHex: "0201abcd", cfAccessClientId: "id", cfAccessClientSecret: "secret" },
    lndHttp.fetchImpl,
  );
  const recorded: InvoiceRecord[] = [];
  const buckets: string[] = [];
  const deps: CreateInvoiceDeps = {
    prepareCheckout: (slug, amount) => {
      if (slug !== "alice") return Promise.reject(new HttpError(404, "link_not_found"));
      if (Number(amount) < 10) return Promise.reject(new HttpError(400, "amount_below_min"));
      if (Number(amount) > 1000) return Promise.reject(new HttpError(400, "amount_above_max"));
      return Promise.resolve({ linkId: "link-1", displayName: "Alice", expirySeconds: 3600 });
    },
    recordInvoice: (r) => {
      recorded.push(r);
      return Promise.resolve("11111111-2222-4333-8444-555555555555");
    },
    rateLimit: (bucket) => {
      buckets.push(bucket);
      return Promise.resolve(true);
    },
    limits: () => Promise.resolve({ perIp: 10, perLink: 30 }),
    btcUsd: () => Promise.resolve(66_666.67),
    addInvoice: (input) => lnd.addInvoice(input),
    ipSalt: "salt",
    brandName: "Boltpage",
    now: () => new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
  return { handler: createHandler(deps), lndCalls: lndHttp.calls, recorded, buckets };
}

const post = (body: unknown) =>
  new Request("https://fn.test/create-invoice", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify(body),
  });

Deno.test("creates a public, 3600 s invoice and records hash, sats and rate", async () => {
  const { handler, lndCalls, recorded } = setup();
  const res = await handler(post({ slug: "alice", amount_usd: "100", hostname: "Pay.Example.com" }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, {
    payment_id: "11111111-2222-4333-8444-555555555555",
    bolt11: "lnbc1ptestinvoice",
    amount_usd: "100.00",
    amount_sats: 150_000,
    expires_at: "2026-01-01T01:00:00.000Z",
  });

  assertEquals(lndCalls.length, 1);
  assertEquals(lndCalls[0].url.pathname, "/v1/invoices");
  const sent = JSON.parse(lndCalls[0].body);
  assertEquals(sent.private, false);
  assertEquals(sent.expiry, "3600");
  assertEquals(sent.value, 150_000);
  assertEquals(lndCalls[0].headers.get("Grpc-Metadata-macaroon"), "0201abcd");
  assertEquals(lndCalls[0].headers.get("CF-Access-Client-Id"), "id");

  assertEquals(recorded, [{
    linkId: "link-1",
    amountUsd: "100.00",
    amountSats: 150_000n,
    btcUsdRate: 66_666.67,
    paymentHash: HASH_A,
    bolt11: "lnbc1ptestinvoice",
    expirySeconds: 3600,
    domain: "pay.example.com",
  }]);
});

Deno.test("amount limits are enforced server-side before LND is called", async () => {
  for (const [amount, code] of [["9.99", "amount_below_min"], ["1000.01", "amount_above_max"], ["10.001", "amount_invalid"], ["abc", "amount_invalid"]]) {
    const { handler, lndCalls } = setup();
    const res = await handler(post({ slug: "alice", amount_usd: amount }));
    assertEquals(res.status, 400, amount);
    assertEquals((await res.json()).error, code);
    assertEquals(lndCalls.length, 0, `no invoice for ${amount}`);
  }
  for (const amount of ["10", "1000"]) {
    const { handler } = setup();
    assertEquals((await handler(post({ slug: "alice", amount_usd: amount }))).status, 200, amount);
  }
});

Deno.test("rate limits per IP (hashed) and per link", async () => {
  const { handler, buckets } = setup();
  await handler(post({ slug: "alice", amount_usd: 10 }));
  assertEquals(buckets.length, 2);
  assertEquals(buckets[0].startsWith("invoice:ip:"), true);
  assertEquals(buckets[0].includes("203.0.113.9"), false, "raw IP is never stored");
  assertEquals(buckets[1], "invoice:link:link-1");

  const limited = setup({ rateLimit: () => Promise.resolve(false) });
  const res = await limited.handler(post({ slug: "alice", amount_usd: 10 }));
  assertEquals(res.status, 429);
  assertEquals(limited.lndCalls.length, 0);
});

Deno.test("LND failure becomes 502 lightning_unavailable and nothing is recorded", async () => {
  const { handler, recorded } = setup({ addInvoice: () => Promise.reject(new Error("tunnel down")) });
  const res = await handler(post({ slug: "alice", amount_usd: 10 }));
  assertEquals(res.status, 502);
  assertEquals((await res.json()).error, "lightning_unavailable");
  assertEquals(recorded.length, 0);
});

Deno.test("unknown slug, wrong method and CORS preflight", async () => {
  const { handler } = setup();
  assertEquals((await handler(post({ slug: "nobody", amount_usd: 10 }))).status, 404);
  assertEquals((await handler(new Request("https://fn.test/x", { method: "GET" }))).status, 405);
  assertEquals((await handler(new Request("https://fn.test/x", { method: "OPTIONS" }))).status, 204);
});
