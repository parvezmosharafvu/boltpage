// Small UI kit shared by the dashboard and the admin panel.
import { getLang, t } from "./i18n.js";
import { h, svg } from "./core.js";

export function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(getLang() === "bn" ? "bn-BD" : "en-GB", {
    timeZone: "Asia/Dhaka",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

export function fmtDate(isoDate) {
  if (!isoDate) return "—";
  return new Intl.DateTimeFormat(getLang() === "bn" ? "bn-BD" : "en-GB", {
    timeZone: "UTC",
    dateStyle: "medium",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

export function badge(status) {
  const key = `status.${status}`;
  const label = t(key);
  return h("span", { class: `badge ${status}` }, label === key ? status : label);
}

// replaceChildren() would render null/false as text; this skips them.
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

export function loading() {
  return h("div", { class: "center-screen" }, h("div", { class: "spinner", role: "status" }));
}

// columns: [{ label, value(row) -> Node|string, num?: true }]
export function table(columns, rows, { empty = "—", onRowClick } = {}) {
  if (!rows.length) return h("div", { class: "table-wrap" }, h("div", { class: "empty" }, empty));
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "data" },
      h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : null, scope: "col" }, c.label)))),
      h(
        "tbody",
        {},
        rows.map((row) =>
          h(
            "tr",
            {
              class: onRowClick ? "clickable" : null,
              tabindex: onRowClick ? "0" : null,
              onclick: onRowClick ? () => onRowClick(row) : null,
              onkeydown: onRowClick ? (e) => e.key === "Enter" && onRowClick(row) : null,
            },
            columns.map((c) => h("td", { class: c.num ? "num" : null }, c.value(row) ?? "—")),
          )
        ),
      ),
    ),
  );
}

// Daily bars. points: [{ date: "YYYY-MM-DD", value }]. Bars stretch with the card width;
// labels stay in HTML so they never distort.
export function barChart(points, { label, format = String } = {}) {
  if (!points.length) return h("div", { class: "empty" }, "—");
  const max = Math.max(1, ...points.map((p) => p.value));
  const W = 600, H = 180, bw = W / points.length;
  return h(
    "div",
    {},
    h("p", { class: "hint" }, `max ${format(max)}`),
    svg(
      "svg",
      { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label ?? "", preserveAspectRatio: "none" },
      points.map((p, i) => {
        const bh = p.value > 0 ? Math.max(2, (p.value / max) * (H - 4)) : 2;
        return svg("rect", { class: p.value > 0 ? "bar" : "bar zero", x: i * bw + 1, y: H - bh, width: Math.max(1, bw - 2), height: bh },
          svg("title", {}, `${fmtDate(p.date)}: ${format(p.value)}`));
      }),
    ),
    h("div", { class: "row between hint" }, h("span", {}, fmtDate(points[0].date)), h("span", {}, fmtDate(points[points.length - 1].date))),
  );
}

// Zero-filled consecutive dates from `from` to `to` (inclusive, YYYY-MM-DD) using byDate values.
export function dailyPoints(from, to, byDate) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, value: byDate.get(key) ?? 0 });
  }
  return out;
}

export function successRate(attempts) {
  const finished = Number(attempts.settled) + Number(attempts.expired) + Number(attempts.failed);
  return { finished, rate: finished ? Math.round((Number(attempts.settled) / finished) * 1000) / 10 : null };
}

export function stat(label, value, sub) {
  return h("div", { class: "card stat" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null);
}

let toastTimer;
export function toast(message) {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: "toast", role: "status" }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

// Modal with optional text input. Resolves to the entered text (or true) or null if cancelled.
export function ask({ title, body, label, required = false, confirmText, danger = false }) {
  return new Promise((resolve) => {
    const input = label ? h("input", { id: "ask-input", autocomplete: "off" }) : null;
    const error = h("p", { class: "error", hidden: true }, t("err.reason_required"));
    const dialog = h(
      "dialog",
      {},
      h(
        "form",
        { method: "dialog" },
        h("h2", {}, title),
        body ? h("p", { class: "muted" }, body) : null,
        input ? h("div", { class: "field" }, h("label", { for: "ask-input" }, label), input, error) : null,
        h(
          "div",
          { class: "form-actions" },
          h("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, value: "ok" }, confirmText ?? t("common.confirm")),
          h("button", { class: "btn btn-ghost", value: "cancel", formnovalidate: true }, t("common.cancel")),
        ),
      ),
    );
    dialog.addEventListener("close", () => {
      const ok = dialog.returnValue === "ok";
      dialog.remove();
      resolve(ok ? (input ? input.value.trim() : true) : null);
    });
    dialog.querySelector("form").addEventListener("submit", (e) => {
      if (e.submitter?.value === "ok" && required && input && !input.value.trim()) {
        e.preventDefault();
        error.hidden = false;
        input.focus();
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    input?.focus();
  });
}

export function showDialog(title, content) {
  const dialog = h(
    "dialog",
    { class: "wide" },
    h("h2", {}, title),
    content,
    h("div", { class: "form-actions" }, h("button", { class: "btn btn-secondary", onclick: () => dialog.close() }, t("common.close"))),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

export async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message ?? t("common.copied"));
  } catch {
    // clipboard unavailable
  }
}

export function field(label, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h("div", { class: "field" }, h("label", { for: id }, label), input, hint ? h("p", { class: "hint" }, hint) : null);
}

// Tabbed shell driven by location.hash. Every switch renders into a fresh panel, so a slow
// render of the previous tab finishes into a detached element instead of overwriting this one.
export function tabs(container, ids, labelFor, render) {
  const nav = h("div", { class: "tabs", role: "tablist" });
  let panel = h("section", { role: "tabpanel" });
  const current = () => (ids.includes(location.hash.slice(1)) ? location.hash.slice(1) : ids[0]);
  const draw = () => {
    const active = current();
    nav.replaceChildren(
      ...ids.map((id) =>
        h("button", {
          class: "tab",
          role: "tab",
          type: "button",
          "aria-selected": String(id === active),
          onclick: () => {
            if (location.hash.slice(1) === id) draw();
            else location.hash = id;
          },
        }, labelFor(id))
      ),
    );
    const fresh = h("section", { role: "tabpanel" }, loading());
    panel.replaceWith(fresh);
    panel = fresh;
    Promise.resolve(render(active, fresh)).catch((err) => {
      fresh.replaceChildren(h("p", { class: "notice bad" }, err?.message ?? String(err)));
    });
  };
  window.addEventListener("hashchange", draw);
  container.append(nav, panel);
  draw();
  return { redraw: draw };
}

export function downloadFile(name, text, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
