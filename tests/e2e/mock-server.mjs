// Local dev + e2e server: serves public/ like the Cloudflare static-assets Worker
// (extensionless HTML, 404.html fallback) and fakes just enough of Supabase (REST, Auth,
// Functions) under /__mock to click through every page. No real money, no real data.
//
//   node tests/e2e/mock-server.mjs           -> http://localhost:8787
//   Demo logins: seller@demo.test / admin@demo.test / pending@demo.test, password demo-password
//   Checkout:    /demo, /narrow (min $20, max $200), /off (checkout disabled)
//   Control:     POST /__mock/control {"status":"settled"|"expired"|"failed"} -> latest invoice
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "public");
const PORT = Number(process.env.PORT || 8787);
const ORIGIN = `http://localhost:${PORT}`;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8",
};

// ---------------------------------------------------------------------------
// Fake data
// ---------------------------------------------------------------------------
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const U = { seller: "11111111-1111-4111-8111-111111111111", admin: "22222222-2222-4222-8222-222222222222", pending: "33333333-3333-4333-8333-333333333333" };

const db = {
  profiles: [
    { id: U.seller, email: "seller@demo.test", full_name: "Rahim Uddin", phone: "+8801700000000", telegram_username: "rahim_demo", telegram_chat_id: null, role: "user", account_status: "active", commission_pct: 5, notify_prefs: { payment: true, daily: true, withdrawal: true }, created_at: iso(now - 40 * 864e5) },
    { id: U.admin, email: "admin@demo.test", full_name: "Admin", phone: null, telegram_username: null, telegram_chat_id: 99, role: "admin", account_status: "active", commission_pct: null, notify_prefs: {}, created_at: iso(now - 90 * 864e5) },
    { id: U.pending, email: "pending@demo.test", full_name: "Karim Pending", phone: "+8801800000000", telegram_username: null, telegram_chat_id: null, role: "user", account_status: "pending", commission_pct: null, notify_prefs: {}, created_at: iso(now - 3600e3) },
  ],
  payment_links: [
    { id: "aaaaaaaa-0000-4000-8000-000000000001", user_id: U.seller, slug: "demo", display_name: "Rahim's Studio", note: "Thanks for your order! Pay any amount between $10 and $1,000.", min_usd: null, max_usd: null, quick_amounts: [10, 25, 50, 100, 250, 500], is_active: true, disabled_by_admin: false, created_at: iso(now - 30 * 864e5), updated_at: iso(now - 864e5) },
    { id: "aaaaaaaa-0000-4000-8000-000000000002", user_id: U.seller, slug: "narrow", display_name: "Narrow Range", note: null, min_usd: 20, max_usd: 200, quick_amounts: [25, 50, 100], is_active: true, disabled_by_admin: false, created_at: iso(now - 10 * 864e5), updated_at: iso(now - 864e5) },
  ],
  payments: [],
  daily_invoices: [],
  withdrawals: [
    { id: randomUUID(), user_id: U.seller, amount_usd: 150, method: "wallet_a", destination_snapshot: { label: "Main", method: "wallet_a", details: { account: "0123456789" } }, status: "paid", reference: "TX-1001", reason: null, created_at: iso(now - 6 * 864e5) },
    { id: randomUUID(), user_id: U.seller, amount_usd: 60, method: "wallet_a", destination_snapshot: { label: "Main", method: "wallet_a", details: { account: "0123456789" } }, status: "requested", reference: null, reason: null, created_at: iso(now - 3600e3) },
  ],
  payout_destinations: [{ id: randomUUID(), user_id: U.seller, method: "wallet_a", label: "Main", details: { account: "0123456789" }, created_at: iso(now - 20 * 864e5) }],
  site_domains: [{ hostname: "localhost", label: "Local", is_active: true }, { hostname: "pay.example.com", label: "Main", is_active: true }],
  app_settings: Object.entries({
    min_usd: 10, max_usd: 1000, invoice_expiry_seconds: 3600, default_commission_pct: 5, withdrawal_min_usd: 20,
    withdrawal_auto_approve_enabled: false, withdrawal_auto_approve_below_usd: 0,
    payout_methods: [{ id: "wallet_a", label: "Wallet A", fields: [{ key: "account", label: "Account number" }] }],
    telegram_bot_username: "boltpage_demo_bot", checkout_enabled: true, admin_require_mfa: false,
    quick_amounts_default: [10, 25, 50, 100, 250, 500], max_links_per_user: 20, support_contact: "support@example.com",
  }).map(([key, value]) => ({ key, value })),
  audit_log: [{ id: 1, actor_id: U.admin, action: "account.set_status", target_table: "profiles", target_id: U.seller, before: { account_status: "pending" }, after: { account_status: "active" }, reason: null, created_at: iso(now - 39 * 864e5) }],
};

// 40 days of settled history so the dashboard chart and statements have shape.
for (let d = 1; d <= 40; d++) {
  const n = (d * 7) % 4;
  for (let i = 0; i < n; i++) {
    const amount = [25, 50, 100, 250][(d + i) % 4];
    const link = db.payment_links[(d + i) % 2];
    db.payments.push({
      id: randomUUID(), link_id: link.id, user_id: U.seller, amount_usd: amount, amount_sats: amount * 1500, btc_usd_rate: 66666.67,
      commission_pct: 5, commission_usd: +(amount * 0.05).toFixed(2), net_usd: +(amount * 0.95).toFixed(2), status: "settled",
      created_at: iso(now - d * 864e5 - i * 3600e3), settled_at: iso(now - d * 864e5 - i * 3600e3 + 20e3), domain: "localhost",
    });
  }
}
db.payments.push({ id: randomUUID(), link_id: db.payment_links[0].id, user_id: U.seller, amount_usd: 40, amount_sats: 60000, btc_usd_rate: 66666.67, commission_pct: 5, commission_usd: 2, net_usd: 38, status: "expired", created_at: iso(now - 7200e3), settled_at: null, domain: "localhost" });
db.payments.sort((a, b) => b.created_at.localeCompare(a.created_at));

function cycleDate(ms) {
  const dhaka = new Date(ms + 6 * 3600e3);
  const date = dhaka.toISOString().slice(0, 10);
  return dhaka.getUTCHours() >= 19 ? new Date(Date.parse(date) + 864e5).toISOString().slice(0, 10) : date;
}
function bounds(date) {
  const end = Date.parse(`${date}T13:00:00Z`);
  return { cycle_start: iso(end - 864e5), cycle_end: iso(end) };
}
const byCycle = new Map();
for (const p of db.payments.filter((x) => x.status === "settled")) {
  const c = cycleDate(Date.parse(p.settled_at));
  const r = byCycle.get(c) ?? { payment_count: 0, gross_usd: 0, commission_usd: 0, net_usd: 0 };
  r.payment_count++; r.gross_usd += p.amount_usd; r.commission_usd += p.commission_usd; r.net_usd += p.net_usd;
  byCycle.set(c, r);
}
for (const [c, r] of byCycle) {
  db.daily_invoices.push({ id: randomUUID(), user_id: U.seller, cycle_date: c, ...bounds(c), ...r, status: c < cycleDate(now - 10 * 864e5) ? "paid_out" : "closed" });
}
db.daily_invoices.sort((a, b) => b.cycle_date.localeCompare(a.cycle_date));

// ---------------------------------------------------------------------------
// Invoice state for checkout tests
// ---------------------------------------------------------------------------
const invoices = new Map();
let lastInvoiceId = null;
const polls = [];

function publicLink(slug) {
  const link = db.payment_links.find((l) => l.slug === slug && l.is_active && !l.disabled_by_admin);
  if (slug === "off") return { slug: "off", display_name: "Paused Shop", note: null, min_usd: 10, max_usd: 1000, quick_amounts: [10, 25], og_version: 1, checkout_enabled: false };
  if (!link) return null;
  const min = Math.max(10, link.min_usd ?? 10);
  const max = Math.min(1000, link.max_usd ?? 1000);
  return { slug, display_name: link.display_name, note: link.note, min_usd: min, max_usd: max, quick_amounts: link.quick_amounts.filter((q) => q >= min && q <= max), og_version: 1, checkout_enabled: true };
}

function createInvoice(body) {
  const link = publicLink(String(body.slug ?? ""));
  if (!link) return [404, { error: "link_not_found" }];
  if (!link.checkout_enabled) return [503, { error: "checkout_disabled" }];
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(body.amount_usd ?? ""));
  if (!m) return [400, { error: "amount_invalid" }];
  const amount = Number(m[0]);
  if (amount < link.min_usd) return [400, { error: "amount_below_min" }];
  if (amount > link.max_usd) return [400, { error: "amount_above_max" }];
  const sats = Math.round((amount / 66666.67) * 1e8);
  const id = randomUUID();
  const bolt11 = `lnbc${Math.round(sats / 10)}n1p${randomBytes(120).toString("hex").replace(/[^a-z0-9]/g, "").slice(0, 220)}`;
  invoices.set(id, { status: "pending", amount_usd: amount.toFixed(2), settled_at: null });
  lastInvoiceId = id;
  return [200, { payment_id: id, bolt11, amount_usd: amount.toFixed(2), amount_sats: sats, expires_at: iso(Date.now() + 3600e3) }];
}

// ---------------------------------------------------------------------------
// Fake auth: unsigned JWT-shaped tokens carrying the user id
// ---------------------------------------------------------------------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function session(user) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: user.id, role: "authenticated", aal: "aal1", exp, email: user.email })}.mock`;
  return { access_token: token, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: `refresh-${user.id}`, user: authUser(user) };
}
function authUser(p) {
  return { id: p.id, aud: "authenticated", role: "authenticated", email: p.email, email_confirmed_at: p.created_at, app_metadata: { provider: "email" }, user_metadata: {}, created_at: p.created_at };
}
function callerId(req) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fake PostgREST: RLS-like ownership filter + eq filters + embeds
// ---------------------------------------------------------------------------
const OWNED = new Set(["payment_links", "payments", "daily_invoices", "withdrawals", "payout_destinations"]);
function tableRows(table, uid, params) {
  const me = db.profiles.find((p) => p.id === uid);
  const admin = me?.role === "admin" && me.account_status === "active";
  let rows = db[table] ?? [];
  if (table === "profiles" && !admin) rows = rows.filter((r) => r.id === uid);
  else if (OWNED.has(table) && !admin) rows = me?.account_status === "active" ? rows.filter((r) => r.user_id === uid) : [];
  else if ((table === "app_settings" || table === "audit_log") && !admin) rows = [];
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset"].includes(k)) continue;
    const [op, ...rest] = v.split(".");
    const val = rest.join(".");
    if (op === "eq") rows = rows.filter((r) => String(r[k]) === val);
    if (op === "gte") rows = rows.filter((r) => r[k] && r[k] >= val);
    if (op === "lte") rows = rows.filter((r) => r[k] && r[k] <= val);
    if (op === "lt") rows = rows.filter((r) => r[k] && r[k] < val);
  }
  const limit = Number(params.get("limit") || 0);
  if (limit) rows = rows.slice(0, limit);
  return rows.map((r) => ({
    ...r,
    payment_links: r.link_id ? { slug: db.payment_links.find((l) => l.id === r.link_id)?.slug } : undefined,
    profiles: r.user_id ? { email: db.profiles.find((p) => p.id === r.user_id)?.email, full_name: db.profiles.find((p) => p.id === r.user_id)?.full_name } : undefined,
  }));
}

function balance(uid) {
  const settled = db.payments.filter((p) => p.user_id === uid && p.status === "settled").reduce((s, p) => s + p.net_usd, 0);
  const withdrawn = db.withdrawals.filter((w) => w.user_id === uid && w.status !== "rejected").reduce((s, w) => s + w.amount_usd, 0);
  return { settled_net_usd: +settled.toFixed(2), withdrawn_usd: withdrawn, available_usd: +(settled - withdrawn).toFixed(2) };
}

function rpc(name, args, uid) {
  const me = db.profiles.find((p) => p.id === uid);
  const active = me?.account_status === "active";
  const notActive = [400, { code: "P0001", message: "account_not_active" }];
  const setting = (k) => db.app_settings.find((s) => s.key === k)?.value;
  switch (name) {
    case "public_link_by_slug": {
      const l = publicLink(String(args.p_slug ?? "").toLowerCase());
      return [200, l ? [l] : []];
    }
    case "public_checkout_config":
      return [200, { min_usd: 10, max_usd: 1000, invoice_expiry_seconds: 3600, checkout_enabled: true, support_contact: "support@example.com" }];
    case "is_admin":
      return [200, me?.role === "admin" && active];
    case "my_app_config":
      return active ? [200, { min_usd: 10, max_usd: 1000, quick_amounts_default: setting("quick_amounts_default"), max_links_per_user: 20, withdrawal_min_usd: 20, payout_methods: setting("payout_methods"), telegram_bot_username: setting("telegram_bot_username"), commission_pct: me.commission_pct ?? 5 }] : notActive;
    case "my_balance":
      return active ? [200, [balance(uid)]] : notActive;
    case "my_overview": {
      if (!active) return notActive;
      const c = cycleDate(Date.now());
      const b = bounds(c);
      const today = db.payments.filter((p) => p.user_id === uid && p.status === "settled" && p.settled_at >= b.cycle_start);
      return [200, { ...balance(uid), cycle_date: c, ...b, today_count: today.length, today_gross_usd: today.reduce((s, p) => s + p.amount_usd, 0), today_net_usd: today.reduce((s, p) => s + p.net_usd, 0), cycle_commission_usd: today.reduce((s, p) => s + p.commission_usd, 0), commission_pct: me.commission_pct ?? 5 }];
    }
    case "my_daily_invoices": {
      if (!active) return notActive;
      const c = cycleDate(Date.now());
      return [200, [{ id: null, cycle_date: c, ...bounds(c), payment_count: 0, gross_usd: 0, commission_usd: 0, net_usd: 0, status: "open", live: true }, ...db.daily_invoices.filter((d) => d.user_id === uid).slice(0, 30).map((d) => ({ ...d, live: false }))]];
    }
    case "my_top_links":
      return active ? [200, db.payment_links.filter((l) => l.user_id === uid).map((l) => { const ps = db.payments.filter((p) => p.link_id === l.id && p.status === "settled"); return { link_id: l.id, slug: l.slug, display_name: l.display_name, payment_count: ps.length, gross_usd: ps.reduce((s, p) => s + p.amount_usd, 0), net_usd: +ps.reduce((s, p) => s + p.net_usd, 0).toFixed(2) }; })] : notActive;
    case "save_my_link": {
      if (!active) return notActive;
      if (db.payment_links.some((l) => l.slug === args.p_slug && l.id !== args.p_id)) return [400, { code: "P0001", message: "slug_taken" }];
      const row = { id: args.p_id ?? randomUUID(), user_id: uid, slug: args.p_slug, display_name: args.p_display_name, note: args.p_note, min_usd: args.p_min_usd, max_usd: args.p_max_usd, quick_amounts: args.p_quick_amounts ?? [10, 25, 50], is_active: args.p_is_active, disabled_by_admin: false, created_at: iso(Date.now()), updated_at: iso(Date.now()) };
      const i = db.payment_links.findIndex((l) => l.id === row.id);
      if (i >= 0) db.payment_links[i] = { ...db.payment_links[i], ...row }; else db.payment_links.push(row);
      return [200, row];
    }
    case "admin_list_accounts":
      if (me?.role !== "admin") return [400, { code: "42501", message: "not_authorized" }];
      return [200, db.profiles.filter((p) => !args.p_status || p.account_status === args.p_status).map((p) => ({ ...p, telegram_connected: Boolean(p.telegram_chat_id), effective_commission_pct: p.commission_pct ?? 5, link_count: db.payment_links.filter((l) => l.user_id === p.id).length, settled_count: db.payments.filter((x) => x.user_id === p.id && x.status === "settled").length, gross_usd: 0, net_usd: 0, ...balance(p.id) }))];
    case "admin_set_account_status": {
      const p = db.profiles.find((x) => x.id === args.p_user);
      if (p) p.account_status = args.p_status;
      return [200, p];
    }
    case "admin_run_daily_settlement":
      return [200, 1];
    case "create_telegram_link_code":
      return [200, [{ code: "c0ffee".repeat(4), deeplink: `https://t.me/${setting("telegram_bot_username")}?start=${"c0ffee".repeat(4)}`, expires_at: iso(Date.now() + 900e3) }]];
    case "update_my_profile": {
      Object.assign(me, { full_name: args.p_full_name, phone: args.p_phone, telegram_username: args.p_telegram_username, notify_prefs: { ...me.notify_prefs, ...(args.p_notify_prefs ?? {}) } });
      return [200, me];
    }
    default:
      // Writes the mock does not model succeed without changing anything.
      return [200, null];
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, { "Content-Type": isBuf ? "application/octet-stream" : "application/json", "Cache-Control": "no-store", ...headers });
  res.end(isBuf || typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function handleMock(req, res, url) {
  const path = url.pathname.slice("/__mock".length);
  const body = req.method === "GET" || req.method === "HEAD" ? {} : await readBody(req);
  const uid = callerId(req);

  if (path === "/control" && req.method === "POST") {
    const inv = invoices.get(body.payment_id ?? lastInvoiceId);
    if (!inv) return send(res, 404, { error: "no invoice" });
    inv.status = body.status;
    if (body.status === "settled") inv.settled_at = iso(Date.now());
    return send(res, 200, { ok: true });
  }
  if (path === "/state") return send(res, 200, { polls, lastInvoiceId, invoices: Object.fromEntries(invoices) });
  if (path === "/reset") {
    polls.length = 0;
    invoices.clear();
    return send(res, 200, { ok: true });
  }

  if (path === "/functions/v1/create-invoice") {
    const [status, out] = createInvoice(body);
    return send(res, status, out);
  }
  if (path === "/functions/v1/payment-status") {
    polls.push(Date.now());
    const inv = invoices.get(url.searchParams.get("id"));
    return inv ? send(res, 200, inv) : send(res, 404, { error: "not_found" });
  }
  if (path === "/functions/v1/node-status") {
    return send(res, 200, { reachable: true, alias: "demo-node", version: "0.19.x", block_height: 900000, synced_to_chain: true, synced_to_graph: true, num_active_channels: 6, num_inactive_channels: 0, num_pending_channels: 1, num_peers: 9, local_balance_sat: 1250000, inbound_liquidity_sat: 8400000 });
  }
  if (path.startsWith("/functions/v1/")) return send(res, 200, { ok: true });

  if (path.startsWith("/auth/v1/")) {
    const route = path.slice("/auth/v1".length);
    if (route === "/token") {
      const grant = url.searchParams.get("grant_type");
      const user = grant === "refresh_token"
        ? db.profiles.find((p) => `refresh-${p.id}` === body.refresh_token)
        : db.profiles.find((p) => p.email === body.email && body.password === "demo-password");
      return user ? send(res, 200, session(user)) : send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
    }
    if (route === "/user") {
      const user = db.profiles.find((p) => p.id === uid);
      return user ? send(res, 200, authUser(user)) : send(res, 401, { message: "invalid token" });
    }
    if (route === "/signup") return send(res, 200, { id: randomUUID(), email: body.email, aud: "authenticated", role: "", user_metadata: body.data ?? {}, identities: [{}] });
    if (route === "/logout") return send(res, 204, "");
    return send(res, 200, {});
  }

  if (path.startsWith("/rest/v1/rpc/")) {
    const [status, out] = rpc(path.slice("/rest/v1/rpc/".length), body, uid);
    return send(res, status, out);
  }
  if (path.startsWith("/rest/v1/")) {
    const table = path.slice("/rest/v1/".length);
    const rows = tableRows(table, uid, url.searchParams);
    const wantsObject = (req.headers.accept ?? "").includes("vnd.pgrst.object");
    const headers = { "Content-Range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` };
    if (req.method === "HEAD") return send(res, 200, undefined, headers);
    return send(res, 200, wantsObject ? rows[0] ?? null : rows, headers);
  }
  return send(res, 404, { error: "unknown mock route" });
}

async function serveStatic(req, res, url) {
  if (url.pathname === "/config.js") {
    return send(res, 200, `window.APP_CONFIG = ${JSON.stringify({ SUPABASE_URL: `${ORIGIN}/__mock`, SUPABASE_ANON_KEY: "mock-anon-key", BRAND_NAME: "Boltpage" })};\n`, { "Content-Type": "text/javascript" });
  }
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  if (rel.includes("..")) return send(res, 400, "bad path", { "Content-Type": "text/plain" });
  const candidates = rel === "" ? ["index.html"] : [rel, `${rel}.html`, join(rel, "index.html")];
  for (const c of candidates) {
    const file = join(ROOT, c);
    if (existsSync(file) && statSync(file).isFile() && !c.startsWith("_")) {
      return send(res, 200, await readFile(file), { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    }
  }
  return send(res, 404, await readFile(join(ROOT, "404.html")), { "Content-Type": TYPES[".html"] });
}

createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
    if (url.pathname.startsWith("/__mock/")) return await handleMock(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    send(res, 500, { error: String(err?.message ?? err) });
  }
}).listen(PORT, () => console.log(`mock server on ${ORIGIN}`));
