import { assertEquals } from "jsr:@std/assert@1";
import { createHandler as createHealth } from "../health/handler.ts";
import { createHandler as createNodeStatus } from "../node-status/handler.ts";
import { createHandler as createWithdraw } from "../user-withdraw/handler.ts";
import { createHandler as createSettlement } from "../daily-settlement/handler.ts";
import { HttpError } from "../_shared/http.ts";
import { truncate } from "../og-image/card.ts";

Deno.test("health reports booleans and alerts admins hourly from cron only", async () => {
  const alerts: string[] = [];
  const handler = createHealth({
    checkDb: () => Promise.resolve(true),
    checkLnd: () => Promise.reject(new Error("tunnel down")),
    isCron: (req) => req.headers.has("x-cron-secret"),
    alertAdmins: (_text, key) => {
      alerts.push(key);
      return Promise.resolve();
    },
    now: () => new Date("2026-01-01T12:34:00Z"),
  });
  const res = await handler(new Request("https://fn.test/health"));
  assertEquals(res.status, 503);
  assertEquals(await res.json(), { ok: false, db: true, lnd: false, synced: false, time: "2026-01-01T12:34:00.000Z" });
  assertEquals(alerts.length, 0);
  await handler(new Request("https://fn.test/health", { headers: { "x-cron-secret": "x" } }));
  assertEquals(alerts, ["health:2026-01-01T12"]);
});

Deno.test("node-status: admin only, inbound liquidity from remote balance", async () => {
  const handler = createNodeStatus({
    authenticateAdmin: (req) =>
      req.headers.get("authorization") === "Bearer admin" ? Promise.resolve({}) : Promise.reject(new HttpError(403, "not_authorized")),
    getInfo: () => Promise.resolve({ alias: "node", synced_to_chain: true, synced_to_graph: true, num_active_channels: 3 }),
    channelBalance: () => Promise.resolve({ local_balance: { sat: "100000" }, remote_balance: { sat: "2500000" } }),
  });
  assertEquals((await handler(new Request("https://fn.test/node-status"))).status, 403);
  const body = await (await handler(new Request("https://fn.test/node-status", { headers: { authorization: "Bearer admin" } }))).json();
  assertEquals(body.reachable, true);
  assertEquals(body.num_active_channels, 3);
  assertEquals(body.inbound_liquidity_sat, 2_500_000);
  assertEquals(body.local_balance_sat, 100_000);
});

Deno.test("user-withdraw: auth required, amount parsed to cents, DB errors mapped", async () => {
  const calls: [string, string][] = [];
  const handler = createWithdraw({
    authenticate: (req) => {
      if (!req.headers.get("authorization")) return Promise.reject(new HttpError(401, "unauthorized"));
      return Promise.resolve({
        userId: "u1",
        requestWithdrawal: (amount, dest) => {
          calls.push([amount, dest]);
          if (amount === "500.00") return Promise.reject(new HttpError(400, "insufficient_balance"));
          return Promise.resolve({ id: "w1", amount_usd: 25, status: "requested", created_at: "2026-01-01T00:00:00Z" });
        },
      });
    },
    rateLimit: () => Promise.resolve(true),
  });
  const req = (body: unknown, auth = true) =>
    new Request("https://fn.test/user-withdraw", {
      method: "POST",
      headers: auth ? { authorization: "Bearer t" } : {},
      body: JSON.stringify(body),
    });
  const dest = "11111111-2222-4333-8444-555555555555";
  assertEquals((await handler(req({ amount_usd: 25, destination_id: dest }, false))).status, 401);
  const ok = await handler(req({ amount_usd: "25", destination_id: dest }));
  assertEquals(await ok.json(), { id: "w1", amount_usd: "25.00", status: "requested", created_at: "2026-01-01T00:00:00Z" });
  assertEquals(calls[0], ["25.00", dest]);
  const tooMuch = await handler(req({ amount_usd: 500, destination_id: dest }));
  assertEquals([tooMuch.status, (await tooMuch.json()).error], [400, "insufficient_balance"]);
  assertEquals((await handler(req({ amount_usd: "1.234", destination_id: dest }))).status, 400);
});

Deno.test("daily-settlement: cron uses the service path, others must be admin", async () => {
  const runs: string[] = [];
  const handler = createSettlement({
    isCron: (req) => req.headers.get("x-cron-secret") === "c",
    runAsService: (d) => {
      runs.push(`service:${d}`);
      return Promise.resolve(3);
    },
    runAsAdmin: () => Promise.reject(new HttpError(403, "not_authorized")),
  });
  const res = await handler(new Request("https://fn.test", {
    method: "POST",
    headers: { "x-cron-secret": "c" },
    body: JSON.stringify({ cycle_date: "2026-03-10" }),
  }));
  assertEquals(await res.json(), { cycle_date: "2026-03-10", rows: 3 });
  assertEquals((await handler(new Request("https://fn.test", { method: "POST", body: "{}" }))).status, 403);
  assertEquals(
    (await handler(new Request("https://fn.test", { method: "POST", headers: { "x-cron-secret": "c" }, body: '{"cycle_date":"10/03/2026"}' }))).status,
    400,
  );
  assertEquals(runs, ["service:2026-03-10"]);
});

Deno.test("OG card text is truncated by characters, not bytes", () => {
  assertEquals(truncate("Alice", 10), "Alice");
  assertEquals(truncate("আলিস রহমান স্টোর", 5).length <= 5 * 2, true);
  assertEquals(truncate("x".repeat(50), 10), "x".repeat(9) + "…");
});
