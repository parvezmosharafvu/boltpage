// Pure helpers shared by every page. No DOM access at import time (unit-tested in Node).

export const POLL_MS = 3000;
export const POLL_HIDDEN_MS = 10000;
export const TERMINAL_STATES = new Set(["settled", "expired", "failed"]);

const AMOUNT_RE = /^(\d{1,7})(?:\.(\d{1,2}))?$/;

// "10", "10.5", "1,000.00" -> cents (integer), or null.
export function parseAmountCents(text) {
  const clean = String(text ?? "").trim().replace(/[$,\s]/g, "");
  const m = AMOUNT_RE.exec(clean);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function toCents(value) {
  return Math.round(Number(value) * 100);
}

// Mirrors the server: positive, at most 2 decimals, within [min, max] inclusive.
export function validateAmount(text, minUsd, maxUsd) {
  const cents = parseAmountCents(text);
  if (cents === null || cents <= 0) return { ok: false, code: "amount_invalid" };
  if (cents < toCents(minUsd)) return { ok: false, code: "amount_below_min" };
  if (cents > toCents(maxUsd)) return { ok: false, code: "amount_above_max" };
  return { ok: true, cents, amount: centsToAmount(cents) };
}

export function centsToAmount(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatSats(value) {
  return Number(value).toLocaleString("en-US");
}

// Deeplink that hands the invoice to the payer's app on mobile.
export function launchUrl(bolt11) {
  return `https://cash.app/launch/lightning/${encodeURIComponent(bolt11)}`;
}

export function lightningUri(bolt11) {
  return `lightning:${bolt11}`;
}

// Uppercase BOLT11 fits QR alphanumeric mode, giving a noticeably less dense code.
export function qrPayload(bolt11) {
  return `LIGHTNING:${String(bolt11).toUpperCase()}`;
}

export function pollDelay(hidden) {
  return hidden ? POLL_HIDDEN_MS : POLL_MS;
}

export function receiptId(paymentId) {
  return String(paymentId).replace(/-/g, "").slice(0, 8).toUpperCase();
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// CSV with quoting and spreadsheet formula-injection protection.
export function toCsv(columns, rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(","));
  return lines.join("\r\n") + "\r\n";
}

// Parses "10, 25, 50" into sorted unique numbers; null on any invalid entry.
export function parseQuickAmounts(text) {
  const parts = String(text ?? "").split(/[\s,]+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const cents = parseAmountCents(p);
    if (cents === null || cents <= 0) return null;
    out.push(cents / 100);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Tiny DOM builder. Strings become text nodes, so user data is never parsed as HTML.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c !== null && c !== undefined) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// Renders a QR matrix (from qrcode-generator) as a single SVG path.
export function qrSvg(qr) {
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    }
  }
  return svg(
    "svg",
    { viewBox: `-2 -2 ${n + 4} ${n + 4}`, role: "img", "shape-rendering": "crispEdges" },
    svg("rect", { x: -2, y: -2, width: n + 4, height: n + 4, fill: "#ffffff" }),
    svg("path", { d, fill: "#0b0b0c" }),
  );
}
