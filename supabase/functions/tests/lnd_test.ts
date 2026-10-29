import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { LndClient, LndError } from "../_shared/lnd.ts";
import { HASH_A, hexToBase64, jsonResponse, mockFetch } from "./helpers.ts";

// Placeholder test credentials (not real secrets).
const CFG = {
  restUrl: "https://lnd-tunnel.example.test",
  macaroonHex: "0201deadbeef",
  cfAccessClientId: "test-client-id.access",
  cfAccessClientSecret: "test-client-secret",
};

Deno.test("addInvoice: POST /v1/invoices with private:false, expiry \"3600\", macaroon and CF Access headers", async () => {
  const { fetchImpl, calls } = mockFetch(() =>
    jsonResponse({ r_hash: hexToBase64(HASH_A), payment_request: "lnbc150u1ptest", add_index: "7" })
  );
  const lnd = new LndClient(CFG, fetchImpl);
  const inv = await lnd.addInvoice({ valueSat: 15000n, memo: "Boltpage: Alice", expirySeconds: 3600 });

  assertEquals(calls.length, 1);
  const call = calls[0];
  assertEquals(call.method, "POST");
  assertEquals(call.url.href, "https://lnd-tunnel.example.test/v1/invoices");
  assertEquals(JSON.parse(call.body), { value: 15000, memo: "Boltpage: Alice", expiry: "3600", private: false });
  assertEquals(call.headers.get("Grpc-Metadata-macaroon"), CFG.macaroonHex);
  assertEquals(call.headers.get("CF-Access-Client-Id"), CFG.cfAccessClientId);
  assertEquals(call.headers.get("CF-Access-Client-Secret"), CFG.cfAccessClientSecret);
  assertEquals(inv, { paymentHash: HASH_A, paymentRequest: "lnbc150u1ptest", addIndex: "7" });
});

Deno.test("addInvoice clamps expiry to 3600 seconds", async () => {
  const { fetchImpl, calls } = mockFetch(() => jsonResponse({ r_hash: hexToBase64(HASH_A), payment_request: "lnbc1x" }));
  await new LndClient(CFG, fetchImpl).addInvoice({ valueSat: 1, memo: "m", expirySeconds: 86_400 });
  assertEquals(JSON.parse(calls[0].body).expiry, "3600");
});

Deno.test("lookupInvoice maps states and settle date", async () => {
  const { fetchImpl, calls } = mockFetch(() =>
    jsonResponse({ state: "SETTLED", settle_date: "1767225600", amt_paid_sat: "15000" })
  );
  const r = await new LndClient(CFG, fetchImpl).lookupInvoice(HASH_A);
  assertEquals(calls[0].url.pathname, `/v1/invoice/${HASH_A}`);
  assertEquals(r?.state, "SETTLED");
  assertEquals(r?.amtPaidSat, 15000);
  assertEquals(r?.settleDate?.toISOString(), "2026-01-01T00:00:00.000Z");
});

Deno.test("lookupInvoice returns null for unknown invoices", async () => {
  const notFound = mockFetch(() => jsonResponse({ code: 5, message: "there are no existing invoices" }, 404));
  assertEquals(await new LndClient(CFG, notFound.fetchImpl).lookupInvoice(HASH_A), null);
  const unknown = mockFetch(() => jsonResponse({ code: 2, message: "unable to locate invoice" }, 500));
  assertEquals(await new LndClient(CFG, unknown.fetchImpl).lookupInvoice(HASH_A), null);
});

Deno.test("Access redirects and server errors surface as LndError", async () => {
  const { fetchImpl } = mockFetch(() => new Response(null, { status: 302, headers: { location: "https://login" } }));
  await assertRejects(() => new LndClient(CFG, fetchImpl).lookupInvoice(HASH_A), LndError);
});

Deno.test("cancelInvoice: POST /v2/invoices/cancel with the base64 payment hash", async () => {
  const { fetchImpl, calls } = mockFetch(() => jsonResponse({}));
  await new LndClient(CFG, fetchImpl).cancelInvoice(HASH_A);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].url.pathname, "/v2/invoices/cancel");
  assertEquals(JSON.parse(calls[0].body), { payment_hash: hexToBase64(HASH_A) });
  assertEquals(calls[0].headers.get("Grpc-Metadata-macaroon"), CFG.macaroonHex);
  await assertRejects(() => new LndClient(CFG, fetchImpl).cancelInvoice("not-a-hash"), LndError);
});

Deno.test("client refuses plain http and non-hex macaroons", () => {
  assertThrows(() => new LndClient({ ...CFG, restUrl: "http://lnd.example.test" }), LndError, "https");
  assertThrows(() => new LndClient({ ...CFG, macaroonHex: "not-hex!" }), LndError, "hex");
  assert(new LndClient({ ...CFG, restUrl: "http://127.0.0.1:8080" }));
});
