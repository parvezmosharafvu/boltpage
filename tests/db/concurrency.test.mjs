// Acceptance 7 and 10 under real concurrency: two connections racing on the same rows.
// Needs a real Postgres that `npm run test:sql` has already migrated (CI does this).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set; runs in CI after npm run test:sql";

async function client() {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

// Runs fn inside its own transaction on its own connection, committing on success.
async function inTx(c, fn) {
  await c.query("begin");
  try {
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback");
    throw err;
  }
}

async function fixture(owner) {
  const email = `race-${randomBytes(6).toString("hex")}@test.local`;
  const { rows: [{ uid }] } = await owner.query("select tests.create_user($1) as uid", [email]);
  await owner.query("update public.profiles set telegram_chat_id = $2 where id = $1", [uid, randomBytes(4).readUInt32BE()]);
  const { rows: [{ lid }] } = await owner.query(
    "insert into public.payment_links (user_id, slug, display_name) values ($1, $2, 'Race') returning id as lid",
    [uid, `race-${randomBytes(4).toString("hex")}`],
  );
  return { uid, lid };
}

test("two concurrent withdrawal requests cannot overdraw", { skip }, async () => {
  const owner = await client();
  const a = await client();
  const b = await client();
  try {
    const { uid, lid } = await fixture(owner);
    await owner.query("select tests.add_payment($1, $2, 100, 'settled')", [uid, lid]); // net 95.00
    await owner.query(`update public.app_settings set value = $1 where key = 'payout_methods'`, [
      JSON.stringify([{ id: "wallet_a", label: "Wallet A", fields: [{ key: "account", label: "Account" }] }]),
    ]);
    const { rows: [{ did }] } = await owner.query(
      `insert into public.payout_destinations (user_id, method, label, details)
       values ($1, 'wallet_a', 'Main', '{"account": "1"}') returning id as did`,
      [uid],
    );

    const request = (c) =>
      inTx(c, async () => {
        await c.query("select tests.as_user($1)", [uid]);
        const { rows } = await c.query("select (public.request_withdrawal(60, $1)).id", [did]);
        return rows[0].id;
      });

    const results = await Promise.allSettled([request(a), request(b)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1, "exactly one request succeeds");
    assert.equal(failed.length, 1);
    assert.match(failed[0].reason.message, /withdrawal_in_progress|insufficient_balance/);

    const { rows: [bal] } = await owner.query("select available_usd from public.user_balances where user_id = $1", [uid]);
    assert.equal(Number(bal.available_usd), 35);
  } finally {
    await Promise.all([owner.end(), a.end(), b.end()]);
  }
});

test("settling the same invoice concurrently credits exactly once", { skip }, async () => {
  const owner = await client();
  const a = await client();
  const b = await client();
  try {
    const { uid, lid } = await fixture(owner);
    const hash = randomBytes(32).toString("hex");
    await owner.query(
      "select public.record_invoice($1, 25, 40000, 62500, $2, 'lnbc1race', 3600, null)",
      [lid, hash],
    );

    const settle = (c) =>
      inTx(c, async () => {
        await c.query("select tests.as_service()");
        const { rows } = await c.query("select public.settle_payment($1, now(), 40000, 'watcher') as won", [hash]);
        // Hold the row lock briefly so the other connection really has to wait.
        await c.query("select pg_sleep(0.2)");
        return rows[0].won;
      });

    const [x, y] = await Promise.all([settle(a), settle(b)]);
    assert.deepEqual([x, y].sort(), [false, true], "one winner, one no-op");

    const { rows: [n] } = await owner.query(
      `select count(*)::int as n from public.notification_outbox o
       join public.payments p on o.dedupe_key = 'settled:' || p.id where p.payment_hash = $1`,
      [hash],
    );
    assert.equal(n.n, 1, "one notification");
  } finally {
    await Promise.all([owner.end(), a.end(), b.end()]);
  }
});
