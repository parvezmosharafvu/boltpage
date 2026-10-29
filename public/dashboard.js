// Logged-in user dashboard (active accounts only; enforced in SQL, explained by the gate).
import { onLangChange, t } from "./i18n.js";
import { formatUsd, h, parseAmountCents, parseQuickAmounts, receiptId, svg, toCsv } from "./core.js";
import { callFunction, errorText, getClient, requireActive, rpc, signOut } from "./auth.js";
import { badge, copyText, downloadFile, field, fill, fmtDate, fmtDateTime, showDialog, stat, table, tabs, toast } from "./ui.js";
import { isValidSlug } from "./slug-rules.js";

const app = document.getElementById("app");
const db = () => getClient();
const TABS = ["overview", "links", "payments", "statements", "withdrawals", "settings"];
const state = { profile: null, config: null, domains: [] };

document.getElementById("logout").addEventListener("click", signOut);

function linkUrls(slug) {
  const hosts = state.domains.length ? state.domains : [location.host];
  return hosts.map((host) => `https://${host}/${slug}`);
}

function methodLabel(id) {
  return (state.config.payout_methods ?? []).find((m) => m.id === id)?.label ?? id;
}

function errorBox() {
  return h("p", { class: "error", role: "alert", hidden: true });
}

function showError(box, err) {
  box.textContent = errorText(err, { min: formatUsd(state.config.min_usd), max: formatUsd(state.config.max_usd) });
  box.hidden = false;
}

const PAYMENT_COLUMNS = () => [
  { label: t("col.date"), value: (p) => fmtDateTime(p.created_at) },
  { label: t("col.link"), value: (p) => (p.payment_links?.slug ? `/${p.payment_links.slug}` : "—") },
  { label: t("col.gross"), value: (p) => formatUsd(p.amount_usd), num: true },
  { label: t("col.commission"), value: (p) => formatUsd(p.commission_usd), num: true },
  { label: t("col.net"), value: (p) => formatUsd(p.net_usd), num: true },
  { label: t("col.status"), value: (p) => badge(p.status) },
  { label: t("col.receipt"), value: (p) => h("span", { class: "mono" }, receiptId(p.id)) },
];

const PAYMENT_SELECT = "id, created_at, settled_at, amount_usd, commission_usd, net_usd, status, payment_links(slug)";

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
async function renderOverview(panel) {
  const [overview, recent, links] = await Promise.all([
    rpc("my_overview"),
    db().from("payments").select(PAYMENT_SELECT).order("created_at", { ascending: false }).limit(10),
    db().from("payment_links").select("id", { count: "exact", head: true }),
  ]);
  fill(panel, 
    links.count === 0
      ? h("div", { class: "notice warn" }, t("dash.noLinksYet"), " ", h("a", { href: "#links" }, t("links.new")))
      : null,
    h(
      "div",
      { class: "grid cols-4" },
      stat(t("dash.available"), formatUsd(overview.available_usd)),
      stat(t("dash.today"), formatUsd(overview.today_net_usd), t("dash.todaySub")),
      stat(t("dash.commission"), formatUsd(overview.cycle_commission_usd), t("dash.commissionSub", { pct: Number(overview.commission_pct) })),
      stat(t("dash.count"), String(overview.today_count)),
    ),
    h("p", { class: "hint" }, t("dash.cycleNote")),
    h("h2", {}, t("dash.recent")),
    table(PAYMENT_COLUMNS(), recent.data ?? [], { empty: t("pays.empty") }),
  );
}

// ---------------------------------------------------------------------------
// Payment links
// ---------------------------------------------------------------------------
function linkPreview(values) {
  const chips = values.quick ?? [];
  return h(
    "div",
    { class: "preview" },
    h("p", { class: "muted small" }, t("links.preview")),
    h(
      "div",
      { class: "payee" },
      h("div", { class: "avatar" }, Array.from(values.display_name || "?")[0].toUpperCase()),
      h("div", {}, h("p", { class: "muted small" }, t("pay.paying")), h("h3", {}, values.display_name || "—")),
    ),
    values.note ? h("p", { class: "note" }, values.note) : null,
    h("div", { class: "chips" }, chips.map((q) => h("span", { class: "chip" }, formatUsd(q).replace(".00", "")))),
  );
}

function linkForm(link, onDone) {
  const cfg = state.config;
  const slug = h("input", { value: link?.slug ?? "", maxlength: 32, autocomplete: "off", required: true });
  const name = h("input", { value: link?.display_name ?? state.profile.full_name ?? "", maxlength: 60, required: true });
  const note = h("textarea", { maxlength: 280 });
  note.value = link?.note ?? "";
  const min = h("input", { value: link?.min_usd ?? "", inputmode: "decimal", placeholder: String(cfg.min_usd) });
  const max = h("input", { value: link?.max_usd ?? "", inputmode: "decimal", placeholder: String(cfg.max_usd) });
  const quick = h("input", { value: (link?.quick_amounts ?? cfg.quick_amounts_default ?? []).map(Number).join(", ") });
  const active = h("input", { type: "checkbox", checked: link ? link.is_active : true });
  const err = errorBox();
  const previewSlot = h("div");

  const values = () => ({
    display_name: name.value.trim(),
    note: note.value.trim(),
    quick: parseQuickAmounts(quick.value) ?? [],
  });
  const refresh = () => previewSlot.replaceChildren(linkPreview(values()));
  for (const el of [name, note, quick]) el.addEventListener("input", refresh);
  refresh();

  const form = h(
    "form",
    { class: "card stack", novalidate: true },
    h("h2", {}, t(link ? "links.edit" : "links.new")),
    h(
      "div",
      { class: "grid cols-2" },
      h(
        "div",
        {},
        field(t("links.slug"), slug, t("links.slugHint")),
        field(t("links.displayName"), name),
        field(t("links.note"), note),
        h(
          "div",
          { class: "grid cols-2" },
          field(t("links.min"), min),
          field(t("links.max"), max),
        ),
        h("p", { class: "hint" }, t("links.rangeHint", { min: formatUsd(cfg.min_usd), max: formatUsd(cfg.max_usd) })),
        field(t("links.quick"), quick, t("links.quickHint")),
        h("label", { class: "check" }, active, t("links.active")),
      ),
      previewSlot,
    ),
    err,
    h(
      "div",
      { class: "form-actions" },
      h("button", { class: "btn btn-primary", type: "submit" }, t("links.save")),
      h("button", { class: "btn btn-ghost", type: "button", onclick: () => onDone(false) }, t("common.cancel")),
    ),
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const s = slug.value.trim().toLowerCase();
    if (!isValidSlug(s)) return showError(err, { code: "slug_invalid" });
    const amount = (input) => {
      if (!input.value.trim()) return null;
      const cents = parseAmountCents(input.value);
      return cents === null ? NaN : cents / 100;
    };
    const minV = amount(min);
    const maxV = amount(max);
    if (Number.isNaN(minV)) return showError(err, { code: "link_min_out_of_range" });
    if (Number.isNaN(maxV)) return showError(err, { code: "link_max_out_of_range" });
    const quickV = parseQuickAmounts(quick.value);
    if (quickV === null) return showError(err, { code: "quick_amount_invalid" });
    try {
      await rpc("save_my_link", {
        p_id: link?.id ?? null,
        p_slug: s,
        p_display_name: name.value.trim(),
        p_note: note.value.trim() || null,
        p_min_usd: minV,
        p_max_usd: maxV,
        p_quick_amounts: quickV,
        p_is_active: active.checked,
      });
      toast(t("common.saved"));
      onDone(true);
    } catch (e2) {
      showError(err, e2);
    }
  });
  return form;
}

async function renderLinks(panel) {
  const { data: links, error } = await db().from("payment_links").select("*").order("created_at", { ascending: true });
  if (error) throw error;
  const area = h("div", { class: "stack" });
  const back = (changed) => (changed ? renderLinks(panel) : draw());
  const draw = () =>
    fill(area, 
      h(
        "div",
        { class: "page-head" },
        h("h2", {}, t("dash.tab.links")),
        h("button", { class: "btn btn-primary", type: "button", onclick: () => fill(area, linkForm(null, back)) }, t("links.new")),
      ),
      links.length
        ? h(
          "div",
          { class: "grid cols-2" },
          links.map((link) =>
            h(
              "div",
              { class: "card link-card" },
              h(
                "div",
                { class: "row between" },
                h("h3", {}, link.display_name),
                link.disabled_by_admin
                  ? h("span", { class: "badge bad" }, t("links.disabledByAdmin"))
                  : link.is_active
                  ? badge("active")
                  : h("span", { class: "badge" }, t("links.inactive")),
              ),
              link.note ? h("p", { class: "muted small" }, link.note) : null,
              h("p", { class: "hint" }, `${formatUsd(link.min_usd ?? state.config.min_usd)} – ${formatUsd(link.max_usd ?? state.config.max_usd)}`),
              linkUrls(link.slug).map((url) =>
                h(
                  "div",
                  { class: "row between" },
                  h("span", { class: "url" }, url),
                  h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => copyText(url, t("links.copied")) }, t("common.copy")),
                )
              ),
              h(
                "div",
                { class: "row" },
                h("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: () => fill(area, linkForm(link, back)) }, t("links.edit")),
                h("a", { class: "btn btn-ghost btn-sm", href: `/${link.slug}`, target: "_blank", rel: "noopener" }, t("links.open")),
              ),
            )
          ),
        )
        : h("div", { class: "card empty" }, t("links.empty")),
    );
  draw();
  fill(panel, area);
}

// ---------------------------------------------------------------------------
// Payments: filters + CSV
// ---------------------------------------------------------------------------
async function renderPayments(panel) {
  const search = h("input", { type: "search", "aria-label": t("pays.search"), placeholder: t("pays.search") });
  const from = h("input", { type: "date", "aria-label": t("pays.from") });
  const to = h("input", { type: "date", "aria-label": t("pays.to") });
  const status = h(
    "select",
    { "aria-label": t("pays.status") },
    h("option", { value: "" }, t("pays.all")),
    ["settled", "pending", "expired", "failed"].map((s) => h("option", { value: s }, t(`status.${s}`))),
  );
  const results = h("div");
  let rows = [];

  const load = async () => {
    fill(results, h("div", { class: "spinner" }));
    let q = db().from("payments").select(PAYMENT_SELECT).order("created_at", { ascending: false }).limit(1000);
    if (status.value) q = q.eq("status", status.value);
    if (from.value) q = q.gte("created_at", `${from.value}T00:00:00+06:00`);
    if (to.value) q = q.lte("created_at", `${to.value}T23:59:59.999+06:00`);
    const { data, error } = await q;
    if (error) throw error;
    const term = search.value.trim().toLowerCase();
    rows = (data ?? []).filter((p) =>
      !term || (p.payment_links?.slug ?? "").includes(term) || receiptId(p.id).toLowerCase().includes(term)
    );
    fill(results, table(PAYMENT_COLUMNS(), rows, { empty: t("pays.empty") }));
  };

  const exportCsv = () => {
    const csv = toCsv(
      [
        { label: "created_at", value: (p) => p.created_at },
        { label: "settled_at", value: (p) => p.settled_at ?? "" },
        { label: "link", value: (p) => p.payment_links?.slug ?? "" },
        { label: "gross_usd", value: (p) => Number(p.amount_usd).toFixed(2) },
        { label: "commission_usd", value: (p) => Number(p.commission_usd).toFixed(2) },
        { label: "net_usd", value: (p) => Number(p.net_usd).toFixed(2) },
        { label: "status", value: (p) => p.status },
        { label: "receipt", value: (p) => receiptId(p.id) },
      ],
      rows,
    );
    downloadFile(`payments-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  };

  const filters = h(
    "form",
    { class: "row", onsubmit: (e) => (e.preventDefault(), load()) },
    h("div", { class: "field" }, search),
    h("div", { class: "field" }, from),
    h("div", { class: "field" }, to),
    h("div", { class: "field" }, status),
    h("button", { class: "btn btn-secondary", type: "submit" }, t("pays.apply")),
    h("button", { class: "btn btn-ghost", type: "button", onclick: exportCsv }, t("pays.export")),
  );
  fill(panel, h("div", { class: "stack" }, filters, results));
  await load();
}

// ---------------------------------------------------------------------------
// Statements: 30-day chart, top links, daily rows with detail
// ---------------------------------------------------------------------------
function earningsChart(rows) {
  const byDate = new Map(rows.map((r) => [r.cycle_date, Number(r.net_usd)]));
  const latest = rows[0]?.cycle_date ? new Date(`${rows[0].cycle_date}T00:00:00Z`) : new Date();
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(latest.getTime() - (29 - i) * 86_400_000).toISOString().slice(0, 10);
    return { date: d, net: byDate.get(d) ?? 0 };
  });
  const max = Math.max(1, ...days.map((d) => d.net));
  const W = 600, H = 180, bw = W / days.length;
  // Bars stretch with the card width; labels stay in HTML so they never distort.
  return h(
    "div",
    {},
    h("p", { class: "hint" }, `max ${formatUsd(max)}`),
    svg(
      "svg",
      { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": t("st.chart"), preserveAspectRatio: "none" },
      days.map((d, i) => {
        const bh = d.net > 0 ? Math.max(2, (d.net / max) * (H - 4)) : 2;
        return svg("rect", { class: d.net > 0 ? "bar" : "bar zero", x: i * bw + 1, y: H - bh, width: bw - 2, height: bh },
          svg("title", {}, `${fmtDate(d.date)}: ${formatUsd(d.net)}`));
      }),
    ),
    h("div", { class: "row between hint" }, h("span", {}, fmtDate(days[0].date)), h("span", {}, fmtDate(days[29].date))),
  );
}

async function statementDetail(row) {
  const { data } = await db()
    .from("payments")
    .select(PAYMENT_SELECT)
    .eq("status", "settled")
    .gte("settled_at", row.cycle_start)
    .lt("settled_at", row.cycle_end)
    .order("settled_at", { ascending: true });
  showDialog(
    t("st.detail", { date: fmtDate(row.cycle_date) }),
    h(
      "div",
      { class: "stack" },
      h(
        "dl",
        { class: "kv" },
        h("dt", {}, t("col.cycle")), h("dd", {}, `${fmtDateTime(row.cycle_start)} → ${fmtDateTime(row.cycle_end)}`),
        h("dt", {}, t("col.count")), h("dd", {}, String(row.payment_count)),
        h("dt", {}, t("col.gross")), h("dd", {}, formatUsd(row.gross_usd)),
        h("dt", {}, t("col.commission")), h("dd", {}, formatUsd(row.commission_usd)),
        h("dt", {}, t("col.net")), h("dd", {}, formatUsd(row.net_usd)),
      ),
      table(PAYMENT_COLUMNS(), data ?? [], { empty: t("pays.empty") }),
    ),
  );
}

async function renderStatements(panel) {
  const [rows, top] = await Promise.all([rpc("my_daily_invoices", { p_days: 30 }), rpc("my_top_links", { p_days: 30 })]);
  fill(panel, 
    h(
      "div",
      { class: "grid cols-2" },
      h("div", { class: "card" }, h("h3", {}, t("st.chart")), earningsChart(rows)),
      h(
        "div",
        { class: "card" },
        h("h3", {}, t("st.top")),
        table(
          [
            { label: t("col.link"), value: (l) => `/${l.slug}` },
            { label: t("col.count"), value: (l) => String(l.payment_count), num: true },
            { label: t("col.net"), value: (l) => formatUsd(l.net_usd), num: true },
          ],
          top,
          { empty: t("pays.empty") },
        ),
      ),
    ),
    h("h2", {}, t("st.list")),
    h("p", { class: "hint" }, t("dash.cycleNote")),
    table(
      [
        { label: t("col.cycle"), value: (r) => fmtDate(r.cycle_date) },
        { label: t("col.count"), value: (r) => String(r.payment_count), num: true },
        { label: t("col.gross"), value: (r) => formatUsd(r.gross_usd), num: true },
        { label: t("col.commission"), value: (r) => formatUsd(r.commission_usd), num: true },
        { label: t("col.net"), value: (r) => formatUsd(r.net_usd), num: true },
        { label: t("col.status"), value: (r) => (r.live ? h("span", { class: "badge open" }, t("st.live")) : badge(r.status)) },
      ],
      rows,
      { empty: t("st.empty"), onRowClick: statementDetail },
    ),
  );
}

// ---------------------------------------------------------------------------
// Withdrawals + payout destinations
// ---------------------------------------------------------------------------
function destinationForm(onSaved) {
  const methods = state.config.payout_methods ?? [];
  if (!methods.length) return h("p", { class: "notice" }, t("wd.noMethods"));
  const method = h("select", {}, methods.map((m) => h("option", { value: m.id }, m.label)));
  const label = h("input", { maxlength: 60 });
  const fieldsBox = h("div");
  const err = errorBox();
  let inputs = {};
  const drawFields = () => {
    const m = methods.find((x) => x.id === method.value);
    inputs = Object.fromEntries((m?.fields ?? []).map((f) => [f.key, h("input", { maxlength: 120, autocomplete: "off" })]));
    fieldsBox.replaceChildren(...(m?.fields ?? []).map((f) => field(f.label, inputs[f.key])));
  };
  method.addEventListener("change", drawFields);
  drawFields();
  const form = h(
    "form",
    { class: "card stack", novalidate: true },
    h("h3", {}, t("wd.addDest")),
    field(t("wd.method"), method),
    field(t("wd.label"), label),
    fieldsBox,
    err,
    h("div", { class: "form-actions" }, h("button", { class: "btn btn-secondary", type: "submit" }, t("wd.saveDest"))),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    try {
      await rpc("save_payout_destination", {
        p_id: null,
        p_method: method.value,
        p_label: label.value.trim(),
        p_details: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()])),
      });
      toast(t("common.saved"));
      onSaved();
    } catch (e2) {
      showError(err, e2);
    }
  });
  return form;
}

async function renderWithdrawals(panel) {
  const [[balance], dests, history] = await Promise.all([
    rpc("my_balance"),
    db().from("payout_destinations").select("*").order("created_at"),
    db().from("withdrawals").select("*").order("created_at", { ascending: false }).limit(100),
  ]);
  const destinations = dests.data ?? [];
  const reload = () => renderWithdrawals(panel);

  const amount = h("input", { inputmode: "decimal", placeholder: "0.00" });
  const dest = h("select", {}, destinations.map((d) => h("option", { value: d.id }, `${d.label} · ${methodLabel(d.method)}`)));
  const err = errorBox();
  const requestForm = h(
    "form",
    { class: "card stack", novalidate: true },
    h("h3", {}, t("wd.request")),
    destinations.length
      ? [
        field(t("wd.amount"), amount, t("wd.min", { min: formatUsd(state.config.withdrawal_min_usd) })),
        field(t("wd.destination"), dest),
        err,
        h("button", { class: "btn btn-primary", type: "submit" }, t("wd.submit")),
      ]
      : h("p", { class: "notice" }, t("wd.noDest")),
  );
  requestForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const cents = parseAmountCents(amount.value);
    if (cents === null || cents <= 0) return showError(err, { code: "amount_invalid" });
    try {
      await callFunction("user-withdraw", { body: { amount_usd: (cents / 100).toFixed(2), destination_id: dest.value } });
      toast(t("wd.requested"));
      reload();
    } catch (e2) {
      showError(err, e2);
    }
  });

  fill(panel, 
    h("div", { class: "grid cols-3" }, stat(t("dash.available"), formatUsd(balance?.available_usd ?? 0))),
    h(
      "div",
      { class: "grid cols-2" },
      requestForm,
      h(
        "div",
        { class: "stack" },
        h("h3", {}, t("wd.destinations")),
        destinations.map((d) =>
          h(
            "div",
            { class: "card tight row between" },
            h("div", {}, h("strong", {}, d.label), h("div", { class: "muted small" }, methodLabel(d.method)),
              h("div", { class: "faint small mono" }, Object.values(d.details ?? {}).join(" · "))),
            h("button", {
              class: "btn btn-ghost btn-sm",
              type: "button",
              onclick: async () => {
                try {
                  await rpc("delete_payout_destination", { p_id: d.id });
                  reload();
                } catch (e2) {
                  toast(errorText(e2));
                }
              },
            }, t("wd.delete")),
          )
        ),
        destinationForm(reload),
      ),
    ),
    h("h2", {}, t("wd.history")),
    table(
      [
        { label: t("col.date"), value: (w) => fmtDateTime(w.created_at) },
        { label: t("col.amount"), value: (w) => formatUsd(w.amount_usd), num: true },
        { label: t("col.method"), value: (w) => methodLabel(w.method) },
        { label: t("col.destination"), value: (w) => w.destination_snapshot?.label ?? "—" },
        { label: t("col.status"), value: (w) => badge(w.status) },
        { label: t("col.note"), value: (w) => w.reason || w.reference || "" },
      ],
      history.data ?? [],
      { empty: t("wd.empty") },
    ),
  );
}

// ---------------------------------------------------------------------------
// Settings: profile, notifications, password, Telegram
// ---------------------------------------------------------------------------
async function renderSettings(panel) {
  const p = state.profile;
  const name = h("input", { value: p.full_name ?? "", maxlength: 120 });
  const phone = h("input", { value: p.phone ?? "", type: "tel", maxlength: 32 });
  const tg = h("input", { value: p.telegram_username ?? "", maxlength: 33 });
  const prefs = { ...{ payment: true, daily: true, withdrawal: true }, ...(p.notify_prefs ?? {}) };
  const prefBoxes = Object.fromEntries(
    ["payment", "daily", "withdrawal"].map((k) => [k, h("input", { type: "checkbox", checked: prefs[k] })]),
  );
  const profileErr = errorBox();

  const saveProfile = async (e) => {
    e?.preventDefault();
    profileErr.hidden = true;
    try {
      state.profile = await rpc("update_my_profile", {
        p_full_name: name.value.trim(),
        p_phone: phone.value.trim(),
        p_telegram_username: tg.value.trim().replace(/^@+/, "") || null,
        p_notify_prefs: Object.fromEntries(Object.entries(prefBoxes).map(([k, el]) => [k, el.checked])),
      });
      toast(t("common.saved"));
    } catch (e2) {
      showError(profileErr, e2);
    }
  };

  const password = h("input", { type: "password", autocomplete: "new-password", minlength: 10 });
  const pwErr = errorBox();
  const savePassword = async (e) => {
    e.preventDefault();
    pwErr.hidden = true;
    if (password.value.length < 10) return showError(pwErr, { code: "password_short" });
    const { error } = await db().auth.updateUser({ password: password.value });
    if (error) {
      pwErr.textContent = error.message;
      pwErr.hidden = false;
      return;
    }
    password.value = "";
    toast(t("set.passwordUpdated"));
  };

  const tgBox = h("div", { class: "stack" });
  const drawTelegram = () => {
    const connected = Boolean(state.profile.telegram_chat_id);
    fill(tgBox, 
      h("p", {}, connected ? badge("active") : h("span", { class: "badge" }, t("set.tgNotConnected")),
        " ", connected ? t("set.tgConnected") : ""),
      connected
        ? h("button", {
          class: "btn btn-secondary btn-sm",
          type: "button",
          onclick: async () => {
            await rpc("disconnect_telegram");
            state.profile.telegram_chat_id = null;
            drawTelegram();
          },
        }, t("set.tgDisconnect"))
        : h("button", {
          class: "btn btn-primary btn-sm",
          type: "button",
          onclick: async () => {
            try {
              const [code] = await rpc("create_telegram_link_code");
              tgBox.append(
                h("p", { class: "hint" }, t("set.tgOpen")),
                h("a", { class: "btn btn-secondary btn-sm", href: code.deeplink, target: "_blank", rel: "noopener" }, t("set.tgOpenButton")),
              );
            } catch (e2) {
              tgBox.append(h("p", { class: "error" }, errorText(e2)));
            }
          },
        }, t("set.tgConnect")),
    );
  };
  drawTelegram();

  fill(panel, 
    h(
      "div",
      { class: "grid cols-2" },
      h(
        "form",
        { class: "card stack", onsubmit: saveProfile, novalidate: true },
        h("h3", {}, t("set.profile")),
        field(t("reg.fullName"), name),
        field(t("reg.email"), h("input", { value: p.email ?? "", disabled: true })),
        field(t("reg.phone"), phone),
        field(t("reg.telegram"), tg, t("reg.telegramHint")),
        h("h3", {}, t("set.notify")),
        Object.entries(prefBoxes).map(([k, el]) => h("label", { class: "check" }, el, t(`set.notify.${k}`))),
        profileErr,
        h("button", { class: "btn btn-primary", type: "submit" }, t("set.saveProfile")),
      ),
      h(
        "div",
        { class: "stack" },
        h("div", { class: "card stack" }, h("h3", {}, t("set.telegram")), tgBox),
        h(
          "form",
          { class: "card stack", onsubmit: savePassword, novalidate: true },
          h("h3", {}, t("set.password")),
          field(t("set.newPassword"), password, t("reg.passwordHint")),
          pwErr,
          h("button", { class: "btn btn-secondary", type: "submit" }, t("set.updatePassword")),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const RENDER = {
  overview: renderOverview,
  links: renderLinks,
  payments: renderPayments,
  statements: renderStatements,
  withdrawals: renderWithdrawals,
  settings: renderSettings,
};

async function boot() {
  const profile = await requireActive(app);
  if (!profile) return;
  state.profile = profile;
  document.getElementById("admin-link").hidden = profile.role !== "admin";
  const [config, domains] = await Promise.all([
    rpc("my_app_config"),
    db().from("site_domains").select("hostname").eq("is_active", true).order("hostname"),
  ]);
  state.config = config;
  state.domains = (domains.data ?? []).map((d) => d.hostname);

  const head = h("div", { class: "page-head" }, h("h1", {}, t("dash.hello", { name: profile.full_name || profile.email })));
  app.replaceChildren(head);
  const shell = tabs(app, TABS, (id) => t(`dash.tab.${id}`), (id, panel) => RENDER[id](panel));
  onLangChange(() => {
    head.firstChild.textContent = t("dash.hello", { name: profile.full_name || profile.email });
    shell.redraw();
  });
}

boot().catch((err) => {
  app.replaceChildren(h("p", { class: "notice bad" }, errorText(err)));
});
