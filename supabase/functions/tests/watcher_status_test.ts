// Acceptance 7: watcher settles exactly once (even when two runs overlap), CANCELED or
// past-expiry invoices expire; payment-status exposes only {status, amount_usd, settled_at}.
import { assertEquals } from "jsr:@std/assert@1";
import { createHandler as createWatcher } from "../lnd-watcher/handler.ts";
import { createHandler as createStatus, type PaymentRow } from "../payment-status/handler.ts";
import type { LookupResult } from "../_shared/lnd.ts";
import { decideTransition } from "../_shared/settle.ts";
import { HASH_A, HASH_B, HASH_C, HASH_D, memoryStore } from "./helpers.ts";

const NOW = new Date("2026-01-01T12:00:00Z");
const FUTURE = "2026-01-01T12:30:00Z";
const PAST = "2026-01-01T11:00:00Z";

const inv = (state: LookupResult["state"]): LookupResult => ({
  state,
  settleDate: state === "SETTLED" ? new Date("2026-01-01T11:59:00Z") : null,
  amtPaidSat: state === "SETTLED" ? 15000 : 0,
});

Deno.test("decideTransition", () => {
  assertEquals(decideTransition({ expires_at: FUTURE }, inv("SETTLED"), NOW), "settled");
  assertEquals(decideTransition({ expires_at: FUTURE }, inv("CANCELED"), NOW), "expired");
  assertEquals(decideTransition({ expires_at: FUTURE }, inv("OPEN"), NOW), "none");
  assertEquals(decideTransition({ expires_at: PAST }, inv("OPEN"), NOW), "expired");
  // Within the grace window after expiry we wait for LND's own cancel.
  assertEquals(decideTransition({ expires_at: "2026-01-01T11:59:30Z" }, inv("OPEN"), NOW), "none");
  assertEquals(decideTransition({ expires_at: FUTURE }, null, NOW), "none");
  assertEquals(decideTransition({ expires_at: PAST }, null, NOW), "failed");
});

function watcherSetup() {
  const store = memoryStore({ [HASH_A]: "pending", [HASH_B]: "pending", [HASH_C]: "pending", [HASH_D]: "pending" });
  const lnd: Record<string, LookupResult | null> = {
    [HASH_A]: inv("SETTLED"),
    [HASH_B]: inv("CANCELED"),
    [HASH_C]: inv("OPEN"),
    [HASH_D]: inv("OPEN"),
  };
  const expiry: Record<string, string> = { [HASH_A]: FUTURE, [HASH_B]: FUTURE, [HASH_C]: FUTURE, [HASH_D]: PAST };
  const handler = createWatcher({
    ...store,
    isAuthorized: (req) => req.headers.get("x-cron-secret") === "cron-test",
    listPending: () =>
      Promise.resolve(
        Object.keys(store.status)
          .filter((h) => store.status[h] === "pending")
          .map((h) => ({ payment_hash: h, expires_at: expiry[h] })),
      ),
    lookupInvoice: async (h) => {
      await new Promise((r) => setTimeout(r, 5)); // let concurrent runs interleave
      return lnd[h];
    },
    now: () => NOW,
  });
  return { handler, store };
}

const cron = () => new Request("https://fn.test/lnd-watcher", { method: "POST", headers: { "x-cron-secret": "cron-test" } });

Deno.test("watcher: SETTLED settles, CANCELED and past-expiry expire, open stays pending", async () => {
  const { handler, store } = watcherSetup();
  const res = await handler(cron());
  assertEquals(await res.json(), { checked: 4, settled: 1, expired: 2, failed: 0, errors: 0 });
  assertEquals(store.status, { [HASH_A]: "settled", [HASH_B]: "expired", [HASH_C]: "pending", [HASH_D]: "expired" });
});

Deno.test("watcher: two overlapping runs settle the invoice exactly once", async () => {
  const { handler, store } = watcherSetup();
  const [a, b] = await Promise.all([handler(cron()), handler(cron())]);
  const total = (await a.json()).settled + (await b.json()).settled;
  assertEquals(total, 1);
  assertEquals(store.status[HASH_A], "settled");
  assertEquals(store.calls.filter((c) => c === `settled:${HASH_A}`).length, 2, "both runs tried");
});

Deno.test("watcher requires the cron secret", async () => {
  const { handler } = watcherSetup();
  assertEquals((await handler(new Request("https://fn.test/lnd-watcher", { method: "POST" }))).status, 401);
});

function statusSetup(lookup: LookupResult | null, lastChecked: string | null = null) {
  const store = memoryStore({ [HASH_A]: "pending" });
  let lookups = 0;
  const row = (): PaymentRow => ({
    id: "11111111-2222-4333-8444-555555555555",
    status: store.status[HASH_A] as PaymentRow["status"],
    amount_usd: 25,
    settled_at: store.status[HASH_A] === "settled" ? "2026-01-01T11:59:00Z" : null,
    payment_hash: HASH_A,
    expires_at: FUTURE,
    last_checked_at: lastChecked,
  });
  const handler = createStatus({
    ...store,
    getPayment: (id) => Promise.resolve(id === "11111111-2222-4333-8444-555555555555" ? row() : null),
    markChecked: () => Promise.resolve(),
    lookupInvoice: () => {
      lookups++;
      return Promise.resolve(lookup);
    },
    rateLimit: () => Promise.resolve(true),
    limitPerMinute: () => Promise.resolve(120),
    ipSalt: "s",
    now: () => NOW,
  });
  return { handler, store, lookups: () => lookups };
}

const get = (id: string) => new Request(`https://fn.test/payment-status?id=${id}`);

Deno.test("payment-status checks LND on demand and returns only public fields", async () => {
  const { handler, store } = statusSetup(inv("SETTLED"));
  const res = await handler(get("11111111-2222-4333-8444-555555555555"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "settled", amount_usd: "25.00", settled_at: "2026-01-01T11:59:00Z" });
  assertEquals(store.status[HASH_A], "settled");
});

Deno.test("payment-status does not hit LND more than every 4 s per payment", async () => {
  const { handler, lookups } = statusSetup(inv("OPEN"), new Date(NOW.getTime() - 1000).toISOString());
  const body = await (await handler(get("11111111-2222-4333-8444-555555555555"))).json();
  assertEquals(body.status, "pending");
  assertEquals(lookups(), 0);
});

Deno.test("payment-status validates the id and 404s unknown payments", async () => {
  const { handler } = statusSetup(null);
  assertEquals((await handler(get("not-a-uuid"))).status, 400);
  assertEquals((await handler(get("99999999-2222-4333-8444-555555555555"))).status, 404);
});
