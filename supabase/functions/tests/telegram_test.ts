// Acceptance 11 (function side): webhook secret header, /start <code>, /stop; outbox drain.
import { assertEquals } from "jsr:@std/assert@1";
import { createHandler as createWebhook, type LinkResult } from "../telegram-webhook/handler.ts";
import { createHandler as createNotify } from "../telegram-notify/handler.ts";
import { parseCommand } from "../_shared/telegram.ts";
import { hasCronSecret } from "../_shared/cron.ts";

function webhook(secret: string | undefined = "hook-secret") {
  const linked: [string, number, string | null][] = [];
  const replies: [number, string][] = [];
  const handler = createWebhook({
    secret,
    linkChat: (code, chatId, username) => {
      linked.push([code, chatId, username]);
      const result: LinkResult = code === "a".repeat(24) ? "linked" : code === "e".repeat(24) ? "expired" : "invalid";
      return Promise.resolve(result);
    },
    unlinkChat: () => Promise.resolve(true),
    reply: (chatId, text) => {
      replies.push([chatId, text]);
      return Promise.resolve();
    },
    brandName: "Boltpage",
  });
  return { handler, linked, replies };
}

const update = (text: string, headers: Record<string, string> = {}, type = "private") =>
  new Request("https://fn.test/telegram-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ message: { text, chat: { id: 4242, type }, from: { username: "seller_tg" } } }),
  });

const SECRET = { "x-telegram-bot-api-secret-token": "hook-secret" };

Deno.test("webhook: missing or wrong secret header -> 403", async () => {
  const { handler, linked } = webhook();
  assertEquals((await handler(update(`/start ${"a".repeat(24)}`))).status, 403);
  assertEquals((await handler(update("/start x", { "x-telegram-bot-api-secret-token": "nope" }))).status, 403);
  assertEquals(linked.length, 0);
});

Deno.test("webhook fails closed when the secret is not configured", async () => {
  const { handler } = webhook(undefined);
  assertEquals((await handler(update("/start x", { "x-telegram-bot-api-secret-token": "" }))).status, 403);
});

Deno.test("webhook: valid /start <code> links the chat; expired code refused", async () => {
  const { handler, linked, replies } = webhook();
  assertEquals((await handler(update(`/start ${"a".repeat(24)}`, SECRET))).status, 200);
  assertEquals(linked[0], ["a".repeat(24), 4242, "seller_tg"]);
  assertEquals(replies[0][1].startsWith("Connected."), true);

  await handler(update(`/start ${"e".repeat(24)}`, SECRET));
  assertEquals(replies[1][1].includes("expired"), true);
});

Deno.test("webhook: /stop unlinks; group chats are ignored", async () => {
  const { handler, replies, linked } = webhook();
  await handler(update("/stop", SECRET));
  assertEquals(replies[0][1].startsWith("Disconnected"), true);
  await handler(update(`/start ${"a".repeat(24)}`, SECRET, "group"));
  assertEquals(linked.length, 0);
});

Deno.test("parseCommand", () => {
  assertEquals(parseCommand("/start abc_DEF-1"), { kind: "start", code: "abc_DEF-1" });
  assertEquals(parseCommand("/start@boltpage_bot abc"), { kind: "start", code: "abc" });
  assertEquals(parseCommand("/start"), { kind: "start", code: null });
  assertEquals(parseCommand("/stop"), { kind: "stop" });
  assertEquals(parseCommand("hello"), { kind: "help" });
});

Deno.test("cron secret check fails closed", async () => {
  const req = new Request("https://fn.test", { headers: { "x-cron-secret": "s3cret" } });
  assertEquals(await hasCronSecret(req, "s3cret"), true);
  assertEquals(await hasCronSecret(req, "other"), false);
  assertEquals(await hasCronSecret(req, undefined), false);
  assertEquals(await hasCronSecret(new Request("https://fn.test"), ""), false);
});

Deno.test("without CRON_SECRET the header is checked against Vault; errors deny", async () => {
  const req = new Request("https://fn.test", { headers: { "x-cron-secret": "from-vault" } });
  const seen: string[] = [];
  const vault = (s: string) => (seen.push(s), Promise.resolve(s === "from-vault"));
  assertEquals(await hasCronSecret(req, undefined, vault), true);
  assertEquals(await hasCronSecret(req, "env-wins", vault), false); // a function secret takes precedence
  assertEquals(await hasCronSecret(new Request("https://fn.test"), undefined, vault), false);
  assertEquals(seen, ["from-vault"]); // never asked without a header or when CRON_SECRET is set
  assertEquals(await hasCronSecret(req, undefined, () => Promise.reject(new Error("db down"))), false);
});

Deno.test("notify drains the outbox and marks permanent failures without retry", async () => {
  const completed: [number, boolean, boolean][] = [];
  const handler = createNotify({
    isAuthorized: () => true,
    token: "test-token",
    claim: () =>
      Promise.resolve([
        { id: 1, chat_id: 10, body: "ok" },
        { id: 2, chat_id: 20, body: "blocked" },
        { id: 3, chat_id: 30, body: "flaky" },
      ]),
    complete: (id, ok, _error, retry) => {
      completed.push([id, ok, retry]);
      return Promise.resolve();
    },
    send: (_t, chatId) =>
      Promise.resolve(
        chatId === 10
          ? { ok: true, retryable: false }
          : chatId === 20
          ? { ok: false, retryable: false, error: "telegram 403" }
          : { ok: false, retryable: true, error: "telegram 429" },
      ),
  });
  const res = await handler(new Request("https://fn.test", { method: "POST" }));
  assertEquals(await res.json(), { sent: 1, failed: 1, retry: 1 });
  assertEquals(completed, [[1, true, false], [2, false, false], [3, false, true]]);
});

Deno.test("notify without a bot token is 503 and claims nothing", async () => {
  let claimed = false;
  const handler = createNotify({
    isAuthorized: () => true,
    token: undefined,
    claim: () => {
      claimed = true;
      return Promise.resolve([]);
    },
    complete: () => Promise.resolve(),
    send: () => Promise.resolve({ ok: true, retryable: false }),
  });
  assertEquals((await handler(new Request("https://fn.test", { method: "POST" }))).status, 503);
  assertEquals(claimed, false);
});
