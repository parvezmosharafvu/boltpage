// Acceptance 16: crawler UA on /<slug> gets OG HTML with a branded, versioned per-link image;
// a normal UA gets the checkout page (pass-through). Also acceptance 12 for crawlers.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import worker, { escapeHtml, isCrawler } from "../../worker/og-preview-worker.js";

const env = { SUPABASE_URL: "https://project.example.test", SUPABASE_ANON_KEY: "anon-test-key", BRAND_NAME: "Boltpage" };
const WHATSAPP = "WhatsApp/2.23.20.0 A";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

let calls;
let cached;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  cached = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => cached.get(req.url)?.clone(),
      put: async (req, res) => void cached.set(req.url, res),
    },
  };
  globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({ url: req.url, body: init.body ?? null, headers: req.headers });
    const url = new URL(req.url);
    if (url.pathname === "/rest/v1/rpc/public_link_by_slug") {
      const { p_slug, p_hostname } = JSON.parse(init.body);
      const active = ["pay.example.com", "pay.example.net"].includes(p_hostname);
      const rows = p_slug === "alice" && active
        ? [{ slug: "alice", display_name: 'Alice <script>alert(1)</script> & Co', note: "Thanks \"friend\"", og_version: 1767225600 }]
        : [];
      return Response.json(rows);
    }
    if (url.pathname === "/functions/v1/og-image") {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });
    }
    return new Response(`origin:${url.pathname}`, { headers: { "content-type": "text/html" } });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.caches;
});

const ctx = { waitUntil: (p) => p };
const get = (url, ua) => worker.fetch(new Request(url, { headers: { "user-agent": ua } }), env, ctx);

test("crawler gets OG HTML with escaped name and versioned image", async () => {
  const res = await get("https://pay.example.com/alice", WHATSAPP);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<meta property="og:title" content="Pay Alice &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Co">/);
  assert.match(html, /<meta property="og:description" content="Thanks &quot;friend&quot;">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/pay\.example\.com\/og\/alice\.v1767225600t1\.png">/);
  assert.doesNotMatch(html, /<script>/);
  const rpc = calls.find((c) => c.url.endsWith("/rpc/public_link_by_slug"));
  assert.deepEqual(JSON.parse(rpc.body), { p_slug: "alice", p_hostname: "pay.example.com" });
});

test("normal browsers get the checkout page (pass-through)", async () => {
  const res = await get("https://pay.example.com/alice", SAFARI);
  assert.equal(await res.text(), "origin:/alice");
  assert.equal(calls.some((c) => c.url.includes("/rpc/")), false);
});

test("/pay/<slug> works for crawlers too; static pages pass through", async () => {
  assert.match(await (await get("https://pay.example.net/pay/alice", WHATSAPP)).text(), /og:title" content="Pay Alice/);
  assert.equal(await (await get("https://pay.example.com/login", WHATSAPP)).text(), "origin:/login");
});

test("unknown slug or inactive hostname -> neutral 404 OG page", async () => {
  assert.equal((await get("https://pay.example.com/nobody", WHATSAPP)).status, 404);
  const res = await get("https://old.example.org/alice", WHATSAPP);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /og-default-v1\.png/);
});

test("home page OG for crawlers uses the absolute home image", async () => {
  const html = await (await get("https://pay.example.com/", "TelegramBot (like TwitterBot)")).text();
  assert.match(html, /og:image" content="https:\/\/pay\.example\.com\/assets\/og\/og-home-v1\.png"/);
});

test("per-link image is proxied once and then served from cache with a year-long TTL", async () => {
  const first = await get("https://pay.example.com/og/alice.v1767225600t1.png", "Slackbot-LinkExpanding 1.0");
  assert.equal(first.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(first.headers.get("content-type"), "image/png");
  await get("https://pay.example.com/og/alice.v1767225600t1.png", "Slackbot-LinkExpanding 1.0");
  assert.equal(calls.filter((c) => c.url.includes("/functions/v1/og-image")).length, 1);
  assert.match(calls[0].url, /og-image\?slug=alice&v=1767225600t1$/);
});

test("crawler detection and escaping", () => {
  for (const ua of [WHATSAPP, "facebookexternalhit/1.1", "Twitterbot/1.0", "Discordbot/2.0", "TelegramBot (like TwitterBot)", "Slackbot 1.0"]) {
    assert.equal(isCrawler(ua), true, ua);
  }
  assert.equal(isCrawler(SAFARI), false);
  assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});
