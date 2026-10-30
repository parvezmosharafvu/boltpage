// Admin-issued invoices, invoice cancel, admin user creation and the public invoice view.
import { assertEquals } from "jsr:@std/assert@1";
import { type AdminDeps, createHandler as createAdmin, type NewUser } from "../admin-actions/handler.ts";
import { createHandler as createView, type InvoiceRow } from "../invoice/handler.ts";
import { issueInvoice } from "../_shared/invoice.ts";
import { HttpError } from "../_shared/http.ts";
import { LndClient } from "../_shared/lnd.ts";
import { HASH_A, hexToBase64, jsonResponse, mockFetch } from "./helpers.ts";

const LINK = "11111111-2222-4333-8444-555555555555";
const PAY = "99999999-2222-4333-8444-555555555555";

function adminSetup(isAdmin = true) {
  const rpcs: [string, Record<string, unknown>][] = [];
  const created: { input: NewUser; origin: string | null }[] = [];
  const invoiceCalls: unknown[] = [];
  const deps: AdminDeps = {
    authenticateAdmin: () =>
      isAdmin
        ? Promise.resolve({ userId: "admin-1", rpc: (fn, args) => (rpcs.push([fn, args]), Promise.resolve(null)) })
        : Promise.reject(new HttpError(403, "not_authorized")),
    adminChatId: () => Promise.resolve(null),
    telegram: { token: undefined, webhookSecret: undefined, webhookUrl: "", call: () => Promise.resolve({}), send: () => Promise.resolve({ ok: true, retryable: false }) },
    invoices: {
      create: (input) => {
        invoiceCalls.push(input);
        return Promise.resolve({ payment_id: PAY, bolt11: "lnbc1x", amount_usd: "75.00", amount_sats: 110000, expires_at: "2026-01-01T01:00:00Z", slug: "seller" });
      },
      cancel: (id) => Promise.resolve(id === PAY ? "expired" : "settled"),
    },
    users: {
      create: (input, origin) => {
        created.push({ input, origin });
        if (input.email === "taken@test.local") return Promise.reject(new HttpError(409, "email_taken"));
        return Promise.resolve({ userId: "new-user", passwordEmailSent: input.password === null });
      },
    },
  };
  return { handler: createAdmin(deps), rpcs, created, invoiceCalls };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://fn.test/admin-actions", { method: "POST", headers: { authorization: "Bearer t", ...headers }, body: JSON.stringify(body) });

Deno.test("admin-actions requires an admin", async () => {
  const { handler } = adminSetup(false);
  assertEquals((await handler(post({ action: "create_invoice", link_id: LINK, amount_usd: 75 }))).status, 403);
});

Deno.test("create_invoice validates input, issues and audits", async () => {
  const { handler, rpcs, invoiceCalls } = adminSetup();
  assertEquals((await handler(post({ action: "create_invoice", link_id: "nope", amount_usd: 75 }))).status, 404);
  assertEquals((await handler(post({ action: "create_invoice", link_id: LINK, amount_usd: "7.555" }))).status, 400);
  assertEquals((await handler(post({ action: "create_invoice", link_id: LINK, amount_usd: 75, memo: "x".repeat(141) }))).status, 400);
  const res = await handler(post({ action: "create_invoice", link_id: LINK, amount_usd: "75", memo: " Order #42 " }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).slug, "seller");
  assertEquals(invoiceCalls, [{ linkId: LINK, cents: 7500n, memo: "Order #42", adminId: "admin-1" }]);
  assertEquals(rpcs[0][0], "admin_record_action");
  assertEquals((rpcs[0][1].p_details as Record<string, unknown>).amount_usd, "75.00");
});

Deno.test("cancel_invoice audits the outcome", async () => {
  const { handler, rpcs } = adminSetup();
  const res = await handler(post({ action: "cancel_invoice", payment_id: PAY }));
  assertEquals(await res.json(), { status: "expired" });
  assertEquals(rpcs[0], ["admin_record_action", { p_action: "invoice.cancel", p_details: { payment_id: PAY, result: "expired" } }]);
  assertEquals((await handler(post({ action: "cancel_invoice", payment_id: "x" }))).status, 400);
});

Deno.test("create_user validates, activates, sets commission and audits", async () => {
  const { handler, rpcs, created } = adminSetup();
  for (const bad of [
    { email: "not-an-email", full_name: "A" },
    { email: "a@test.local", full_name: "" },
    { email: "a@test.local", full_name: "A", password: "short" },
    { email: "a@test.local", full_name: "A", telegram_username: "@ab" },
    { email: "a@test.local", full_name: "A", commission_pct: 101 },
  ]) {
    assertEquals((await handler(post({ action: "create_user", ...bad }))).status, 400, JSON.stringify(bad));
  }
  const res = await handler(post(
    { action: "create_user", email: "New@Test.Local", full_name: "New User", telegram_username: "@new_user", activate: true, commission_pct: 2.5 },
    { origin: "https://pay.example.com" },
  ));
  assertEquals(await res.json(), { user_id: "new-user", activated: true, password_email_sent: true });
  assertEquals(created[0].input, { email: "new@test.local", fullName: "New User", phone: null, telegramUsername: "new_user", password: null });
  assertEquals(created[0].origin, "https://pay.example.com");
  assertEquals(rpcs.map(([fn]) => fn), ["admin_set_account_status", "admin_set_commission", "admin_record_action"]);
  assertEquals((await handler(post({ action: "create_user", email: "taken@test.local", full_name: "T" }))).status, 409);
});

Deno.test("create_user takes any commission with up to two decimals (1.1 * 100 is not 110 in floats)", async () => {
  for (const pct of [1.1, 2.55, 5.1, "0.07", 0, 100]) {
    const { handler, rpcs } = adminSetup();
    const res = await handler(post({ action: "create_user", email: "c@test.local", full_name: "C", commission_pct: pct }));
    assertEquals(res.status, 200, String(pct));
    assertEquals(rpcs.find(([fn]) => fn === "admin_set_commission")?.[1].p_pct, Number(pct));
  }
  for (const pct of [1.234, -1, 100.01, "1e1", "abc", " "]) {
    const { handler } = adminSetup();
    const res = await handler(post({ action: "create_user", email: "c@test.local", full_name: "C", commission_pct: pct }));
    assertEquals(res.status, 400, String(pct));
  }
});

Deno.test("issueInvoice passes memo and issuer through and uses the memo in the LND memo", async () => {
  const lndHttp = mockFetch(() => jsonResponse({ r_hash: hexToBase64(HASH_A), payment_request: "lnbc1memo" }));
  const lnd = new LndClient({ restUrl: "https://lnd.example.test", macaroonHex: "0201ab" }, lndHttp.fetchImpl);
  const records: unknown[] = [];
  const out = await issueInvoice({
    prepareCheckout: () => Promise.resolve({ linkId: LINK, displayName: "Seller", expirySeconds: 3600 }),
    recordInvoice: (r) => (records.push(r), Promise.resolve(PAY)),
    btcUsd: () => Promise.resolve(50_000),
    addInvoice: (i) => lnd.addInvoice(i),
    brandName: "Boltpage",
  }, { slug: "seller", cents: 7500n, hostname: null, memo: "Order #42", issuedBy: "admin-1" });
  assertEquals(out.payment_id, PAY);
  assertEquals(JSON.parse(lndHttp.calls[0].body).memo, "Boltpage: Order #42");
  assertEquals((records[0] as { memo: string; issuedBy: string }).memo, "Order #42");
  assertEquals((records[0] as { memo: string; issuedBy: string }).issuedBy, "admin-1");
});

function viewSetup(row: InvoiceRow | null) {
  return createView({
    getInvoice: (id) => Promise.resolve(id === PAY ? row : null),
    rateLimit: () => Promise.resolve(true),
    limitPerMinute: () => Promise.resolve(120),
    ipSalt: "s",
  });
}

const ROW: InvoiceRow = {
  status: "pending", amount_usd: 75, amount_sats: "110000", bolt11: "lnbc1secret", expires_at: "2026-01-01T01:00:00Z",
  settled_at: null, memo: "Order #42", display_name: "Seller", slug: "seller",
};

Deno.test("invoice view: bolt11 only while payable; public fields only", async () => {
  const pending = await (await viewSetup(ROW)(new Request(`https://fn.test/invoice?id=${PAY}`))).json();
  assertEquals(pending, {
    payment_id: PAY, status: "pending", amount_usd: "75.00", amount_sats: 110000, bolt11: "lnbc1secret",
    expires_at: "2026-01-01T01:00:00Z", settled_at: null, memo: "Order #42", display_name: "Seller", slug: "seller",
  });
  const settled = await (await viewSetup({ ...ROW, status: "settled", settled_at: "2026-01-01T00:10:00Z" })(new Request(`https://fn.test/invoice?id=${PAY}`))).json();
  assertEquals(settled.bolt11, null);
  assertEquals((await viewSetup(ROW)(new Request("https://fn.test/invoice?id=bad"))).status, 400);
  assertEquals((await viewSetup(ROW)(new Request("https://fn.test/invoice?id=11111111-2222-4333-8444-555555555555"))).status, 404);
});
