// Public checkout for /<slug> and /pay/<slug> (served via 404.html).
// Talks to Supabase over plain fetch, so the checkout never loads the auth SDK.
import { brandName, onLangChange, t } from "./i18n.js";
import {
  formatCountdown, formatSats, formatUsd, h, launchUrl, lightningUri, pollDelay, qrPayload, qrSvg, receiptId,
  TERMINAL_STATES, validateAmount,
} from "./core.js";
import { slugFromPath } from "./slug-rules.js";
import qrcode from "./vendor/qrcode.mjs";

const cfg = window.APP_CONFIG ?? {};
const $ = (id) => document.getElementById(id);
const VIEWS = ["loading", "notfound", "amount", "invoice", "success", "expired", "failed"];

const state = {
  slug: null,
  link: null,
  invoice: null,
  pollTimer: null,
  tickTimer: null,
  polling: false,
  lastAmount: "",
};

function show(view) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  window.scrollTo(0, 0);
}

function apiHeaders() {
  const key = cfg.SUPABASE_ANON_KEY ?? "";
  // New-style publishable keys are not JWTs and go in apikey only.
  return key.startsWith("sb_publishable_")
    ? { apikey: key, "Content-Type": "application/json" }
    : { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function rpc(name, args) {
  const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${name}: ${res.status}`);
  return res.json();
}

async function callFunction(path, init = {}) {
  const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/${path}`, { ...init, headers: apiHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || "generic");
    err.code = body.error || "generic";
    throw err;
  }
  return body;
}

function limits() {
  return { min: formatUsd(state.link.min_usd), max: formatUsd(state.link.max_usd) };
}

function errorText(code) {
  const key = `err.${code}`;
  const text = t(key, limits());
  return text === key ? t("err.generic") : text;
}

// ---------------------------------------------------------------------------
// Amount step
// ---------------------------------------------------------------------------
function renderAmount() {
  const link = state.link;
  $("payee-name").textContent = link.display_name;
  $("payee-initial").textContent = Array.from(link.display_name.trim())[0]?.toUpperCase() ?? "?";
  $("payee-note").hidden = !link.note;
  $("payee-note").textContent = link.note ?? "";
  $("amount-hint").textContent = t("pay.range", limits());
  $("checkout-off").hidden = link.checkout_enabled;
  $("continue").disabled = !link.checkout_enabled;
  document.title = `${t("pay.paying")}: ${link.display_name} · ${brandName()}`;

  const chips = $("chips");
  chips.replaceChildren(
    ...(link.quick_amounts ?? []).map((q) =>
      h("button", {
        type: "button",
        class: "chip",
        "aria-pressed": "false",
        onclick: (e) => {
          $("amount").value = Number(q).toFixed(2);
          for (const c of chips.children) c.setAttribute("aria-pressed", String(c === e.currentTarget));
          setAmountError(null);
        },
      }, formatUsd(q).replace(".00", "")),
    ),
  );
}

function setAmountError(code) {
  const el = $("amount-error");
  el.hidden = !code;
  el.textContent = code ? errorText(code) : "";
  $("amount").setAttribute("aria-invalid", code ? "true" : "false");
}

async function submitAmount(event) {
  event.preventDefault();
  const check = validateAmount($("amount").value, state.link.min_usd, state.link.max_usd);
  if (!check.ok) {
    setAmountError(check.code);
    return;
  }
  setAmountError(null);
  state.lastAmount = check.amount;
  const button = $("continue");
  button.disabled = true;
  button.textContent = t("pay.creating");
  try {
    const invoice = await callFunction("create-invoice", {
      method: "POST",
      body: JSON.stringify({ slug: state.slug, amount_usd: check.amount, hostname: location.hostname }),
    });
    startInvoice(invoice);
  } catch (err) {
    setAmountError(err.code ?? "network");
  } finally {
    button.disabled = !state.link.checkout_enabled;
    button.textContent = t("pay.continue");
  }
}

// ---------------------------------------------------------------------------
// Invoice step: QR, deeplinks, countdown, polling
// ---------------------------------------------------------------------------
function startInvoice(invoice) {
  state.invoice = invoice;
  $("inv-usd").textContent = formatUsd(invoice.amount_usd);
  $("inv-sats").textContent = t("pay.sats", { n: formatSats(invoice.amount_sats) });
  $("inv-payee").textContent = state.link.display_name;
  $("inv-memo").hidden = !invoice.memo;
  $("inv-memo").textContent = invoice.memo ?? "";
  $("open-deeplink").href = launchUrl(invoice.bolt11);
  $("open-wallet").href = lightningUri(invoice.bolt11);
  $("inv-status").textContent = t("pay.waiting");

  const qr = qrcode(0, "L");
  qr.addData(qrPayload(invoice.bolt11), "Alphanumeric");
  qr.make();
  $("inv-qr").replaceChildren(qrSvg(qr));

  show("invoice");
  tick();
  clearInterval(state.tickTimer);
  state.tickTimer = setInterval(tick, 1000);
  state.polling = true;
  schedulePoll();
}

function tick() {
  const left = new Date(state.invoice.expires_at).getTime() - Date.now();
  $("inv-timer").textContent = formatCountdown(left);
  if (left <= 0) $("inv-status").textContent = t("pay.checking");
}

function schedulePoll(delay = pollDelay(document.hidden)) {
  clearTimeout(state.pollTimer);
  if (state.polling) state.pollTimer = setTimeout(poll, delay);
}

async function poll() {
  if (!state.polling) return;
  try {
    const status = await callFunction(`payment-status?id=${encodeURIComponent(state.invoice.payment_id)}`, { method: "GET" });
    if (TERMINAL_STATES.has(status.status)) {
      finish(status);
      return;
    }
  } catch {
    // transient: keep polling
  }
  schedulePoll();
}

function stopPolling() {
  state.polling = false;
  clearTimeout(state.pollTimer);
  clearInterval(state.tickTimer);
}

function finish(status) {
  stopPolling();
  if (status.status === "settled") {
    $("ok-usd").textContent = formatUsd(status.amount_usd);
    $("ok-body").textContent = t("pay.success.body", { name: state.link.display_name });
    $("ok-receipt").textContent = receiptId(state.invoice.payment_id);
    show("success");
  } else if (status.status === "expired") {
    show("expired");
  } else {
    show("failed");
  }
}

function backToAmount() {
  stopPolling();
  state.invoice = null;
  if (location.search) history.replaceState(null, "", location.pathname); // drop ?i= so a reload starts fresh
  if (!state.canStartNew) {
    show("notfound");
    return;
  }
  renderAmount();
  $("amount").value = state.lastAmount;
  show("amount");
  $("amount").focus();
}

// Slow down while hidden; check immediately when the payer comes back from their wallet.
document.addEventListener("visibilitychange", () => {
  if (!state.polling) return;
  if (document.hidden) schedulePoll();
  else poll();
});
window.addEventListener("focus", () => {
  if (state.polling) poll();
});

$("copy-invoice").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.invoice.bolt11);
    $("copy-invoice").textContent = t("pay.copied");
    setTimeout(() => ($("copy-invoice").textContent = t("pay.copy")), 1500);
  } catch {
    // clipboard blocked: the QR and wallet buttons still work
  }
});
$("amount-form").addEventListener("submit", submitAmount);
$("amount").addEventListener("input", () => setAmountError(null));
$("expired-again").addEventListener("click", backToAmount);
$("failed-again").addEventListener("click", backToAmount);
onLangChange(() => {
  if (state.link) {
    $("amount-hint").textContent = t("pay.range", limits());
    if (!$("amount-error").hidden) setAmountError(null);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /<slug>?i=<payment id>: an invoice an admin issued on this link. Opens straight to the QR
// (or to its final state). The id is the capability; the slug must match.
async function bootInvoice(paymentId) {
  let view;
  try {
    view = await callFunction(`invoice?id=${encodeURIComponent(paymentId)}`, { method: "GET" });
  } catch {
    view = null;
  }
  if (!view || view.slug !== state.slug) {
    show("notfound");
    return;
  }
  if (!state.link) {
    state.link = { display_name: view.display_name, min_usd: 0, max_usd: 0, quick_amounts: [], checkout_enabled: false };
  }
  state.lastAmount = view.amount_usd;
  if (view.status === "pending" && view.bolt11) {
    startInvoice({ ...view, payment_id: paymentId });
  } else {
    state.invoice = { payment_id: paymentId };
    finish(view);
  }
}

async function boot() {
  state.slug = slugFromPath(location.pathname);
  if (!state.slug) {
    show("notfound");
    return;
  }
  try {
    const rows = await rpc("public_link_by_slug", { p_slug: state.slug, p_hostname: location.hostname });
    state.link = Array.isArray(rows) ? rows[0] : null;
  } catch {
    state.link = null;
  }
  state.canStartNew = Boolean(state.link);
  if (state.link) {
    state.link.min_usd = Number(state.link.min_usd);
    state.link.max_usd = Number(state.link.max_usd);
  }

  const invoiceId = new URLSearchParams(location.search).get("i");
  if (invoiceId && UUID_RE.test(invoiceId)) {
    await bootInvoice(invoiceId);
    return;
  }
  if (!state.link) {
    show("notfound");
    return;
  }
  renderAmount();
  show("amount");
}

boot();
