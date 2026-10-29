// Admin panel. Every write is an audited SECURITY DEFINER RPC that re-checks is_admin()
// (role + active + aal2 when admin_require_mfa is on); this UI is only a convenience.
import { t } from "./i18n.js";
import { formatUsd, h, parseAmountCents, receiptId } from "./core.js";
import { callFunction, enhancePasswords, errorText, getClient, requireActive, rpc, sessionAal, signOut } from "./auth.js";
import {
  ask, badge, barChart, copyText, dailyPoints, field, fill, fmtDate, fmtDateTime, stat, successRate, table, tabs, toast,
} from "./ui.js";

const app = document.getElementById("app");
const db = () => getClient();
const TABS = [
  "overview", "approvals", "users", "links", "payments", "invoices", "withdrawals", "methods", "domains", "settings", "node", "audit",
];
let me = null;

document.getElementById("logout").addEventListener("click", signOut);

// Runs an admin action, reports the outcome, then re-renders the tab.
// okMessage may be a function of the action's result.
async function act(fn, done, okMessage = t("common.saved")) {
  try {
    const result = await fn();
    toast(typeof okMessage === "function" ? okMessage(result) : okMessage);
    done?.();
  } catch (err) {
    toast(errorText(err));
  }
}

const btn = (label, onclick, cls = "btn-secondary") =>
  h("button", { class: `btn ${cls} btn-sm`, type: "button", onclick }, label);

// payments has two foreign keys to profiles (owner, issuing admin): name the owner one.
const PAYMENT_SELECT = "*, payment_links(slug), profiles!payments_user_id_fkey(email)";

const errorBox = () => h("p", { class: "error", role: "alert", hidden: true });
function showError(box, err) {
  box.textContent = errorText(err);
  box.hidden = false;
}

async function activeUsers() {
  return (await rpc("admin_list_accounts", { p_status: "active" })) ?? [];
}

// ---------------------------------------------------------------------------
// Overview: revenue includes commission; "today" is the current 19:00 Dhaka cycle.
// ---------------------------------------------------------------------------
async function renderOverview(panel) {
  const o = await rpc("admin_overview");
  const a = o.attempts_month;
  const { finished, rate } = successRate(a);
  const byDate = new Map((o.daily ?? []).map((d) => [d.cycle_date, Number(d.gross_usd)]));
  const from = new Date(new Date(`${o.cycle_date}T00:00:00Z`).getTime() - 29 * 86_400_000).toISOString().slice(0, 10);

  fill(
    panel,
    h("div", { class: "stack" },
    h("p", { class: "hint" }, "Revenue includes commission. Today = the current 19:00 → 19:00 Dhaka cycle; month = the Dhaka calendar month. Payable = settled net minus withdrawals already paid."),
    h(
      "div",
      { class: "grid cols-4" },
      stat("Revenue today", formatUsd(o.today.gross_usd), `${o.today.count} paid · commission ${formatUsd(o.today.commission_usd)}`),
      stat("Revenue this month", formatUsd(o.month.gross_usd), `${o.month.count} paid · commission ${formatUsd(o.month.commission_usd)}`),
      stat("Commission all time", formatUsd(o.all_time.commission_usd), `on ${formatUsd(o.all_time.gross_usd)} collected`),
      stat("Payable to users", formatUsd(o.payable_usd), "still owed after paid withdrawals"),
    ),
    h(
      "div",
      { class: "grid cols-4" },
      stat("Success rate (month)", rate === null ? "—" : `${rate}%`, `${a.settled} paid · ${a.expired} expired · ${a.failed} failed of ${finished}`),
      stat("Open withdrawals", String(o.withdrawals_open.count), formatUsd(o.withdrawals_open.amount_usd)),
      stat("Users", String(o.users.active), `${o.users.pending} waiting · ${o.users.blocked} rejected/suspended`),
      stat("Active links", String(o.links.active), `${o.links.total} in total`),
    ),
    h(
      "div",
      { class: "grid cols-2" },
      stat("Outstanding statements", String(o.outstanding_statements.count), `${formatUsd(o.outstanding_statements.net_usd)} closed, not yet paid out`),
      stat("Open invoices", String(o.outstanding_invoices.count), `${formatUsd(o.outstanding_invoices.amount_usd)} waiting for payment`),
    ),
    h(
      "div",
      { class: "row" },
      o.users.pending ? h("a", { class: "btn btn-primary btn-sm", href: "#approvals" }, `Review ${o.users.pending} account(s)`) : null,
      o.withdrawals_open.count ? h("a", { class: "btn btn-secondary btn-sm", href: "#withdrawals" }, "Review withdrawals") : null,
    ),
    h("div", { class: "card" }, h("h3", {}, "Daily revenue, last 30 cycles"), barChart(dailyPoints(from, o.cycle_date, byDate), { label: "Daily revenue", format: formatUsd })),
    h("h2", {}, "Top users this month"),
    table(
      [
        { label: "User", value: (u) => h("div", {}, h("strong", {}, u.full_name || "—"), h("div", { class: "muted small" }, u.email)) },
        { label: "Paid", value: (u) => String(u.count), num: true },
        { label: "Revenue", value: (u) => formatUsd(u.gross_usd), num: true },
        { label: "Commission", value: (u) => formatUsd(u.commission_usd), num: true },
      ],
      o.top_users ?? [],
      { empty: "No paid payments this month yet." },
    )),
  );
}

// ---------------------------------------------------------------------------
async function renderApprovals(panel) {
  const rows = await rpc("admin_list_accounts", { p_status: "pending" });
  const reload = () => renderApprovals(panel);
  fill(panel, 
    h("h2", {}, `Accounts waiting for approval (${rows.length})`),
    table(
      [
        { label: "Name", value: (u) => u.full_name || "—" },
        { label: "Email", value: (u) => u.email },
        { label: "Phone", value: (u) => u.phone || "—" },
        { label: "Telegram", value: (u) => (u.telegram_username ? `@${u.telegram_username}` : "—") },
        { label: "Signed up", value: (u) => fmtDateTime(u.created_at) },
        {
          label: "Actions",
          value: (u) =>
            h(
              "div",
              { class: "row" },
              btn("Approve", () => act(() => rpc("admin_set_account_status", { p_user: u.id, p_status: "active" }), reload), "btn-primary"),
              btn("Reject", async () => {
                const reason = await ask({ title: `Reject ${u.email}?`, label: "Reason (shown to the user)", required: true, danger: true, confirmText: "Reject" });
                if (reason) act(() => rpc("admin_set_account_status", { p_user: u.id, p_status: "rejected", p_reason: reason }), reload);
              }, "btn-danger"),
            ),
        },
      ],
      rows,
      { empty: "No accounts are waiting." },
    ),
  );
}

// ---------------------------------------------------------------------------
async function renderUsers(panel) {
  const search = h("input", { type: "search", placeholder: "Search name, email, phone, Telegram" });
  const status = h("select", {}, h("option", { value: "" }, "All statuses"), ["pending", "active", "rejected", "suspended"].map((s) => h("option", { value: s }, s)));
  const results = h("div");

  const load = async () => {
    const rows = await rpc("admin_list_accounts", { p_status: status.value || null, p_search: search.value.trim() || null });
    fill(results, 
      table(
        [
          { label: "User", value: (u) => h("div", {}, h("strong", {}, u.full_name || "—"), h("div", { class: "muted small" }, u.email), u.role === "admin" ? h("span", { class: "badge" }, "admin") : null) },
          { label: "Status", value: (u) => badge(u.account_status) },
          {
            label: "Commission %",
            value: (u) => {
              const input = h("input", { value: u.commission_pct ?? "", placeholder: `${u.effective_commission_pct} (default)`, inputmode: "decimal", size: 8 });
              return h(
                "div",
                { class: "row" },
                input,
                btn("Set", () =>
                  act(() => rpc("admin_set_commission", { p_user: u.id, p_pct: input.value.trim() === "" ? null : Number(input.value) }), load)),
              );
            },
          },
          { label: "Available", value: (u) => formatUsd(u.available_usd), num: true },
          { label: "Gross", value: (u) => formatUsd(u.gross_usd), num: true },
          { label: "Paid", value: (u) => String(u.settled_count), num: true },
          { label: "Links", value: (u) => String(u.link_count), num: true },
          {
            label: "Actions",
            value: (u) => {
              if (u.id === me.id) return h("span", { class: "faint small" }, "you");
              if (u.account_status === "active") {
                return btn("Suspend", async () => {
                  const reason = await ask({ title: `Suspend ${u.email}?`, label: "Reason", required: true, danger: true, confirmText: "Suspend" });
                  if (reason) act(() => rpc("admin_set_account_status", { p_user: u.id, p_status: "suspended", p_reason: reason }), load);
                }, "btn-danger");
              }
              return btn(u.account_status === "pending" ? "Approve" : "Reactivate", () =>
                act(() => rpc("admin_set_account_status", { p_user: u.id, p_status: "active" }), load), "btn-primary");
            },
          },
        ],
        rows,
        { empty: "No users match." },
      ),
    );
  };
  const createSlot = h("div");
  const openCreate = () => fill(createSlot, createUserForm(() => {
    fill(createSlot);
    load();
  }));
  fill(panel,
    h(
      "div",
      { class: "row between" },
      h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), load()) }, h("div", { class: "field" }, search), h("div", { class: "field" }, status), h("button", { class: "btn btn-secondary", type: "submit" }, "Search")),
      btn("Create user", openCreate, "btn-primary"),
    ),
    createSlot,
    h("p"),
    results,
  );
  await load();
}

// Creates a login for someone directly. Leaving the password empty emails them a
// set-password link (to the domain you're on, if it's an active site domain).
function createUserForm(onDone) {
  const email = h("input", { type: "email", autocomplete: "off", required: true });
  const name = h("input", { maxlength: 120, required: true });
  const phone = h("input", { type: "tel", maxlength: 32 });
  const telegram = h("input", { maxlength: 33, placeholder: "without @" });
  const password = h("input", { type: "password", autocomplete: "new-password", minlength: 10 });
  const commission = h("input", { inputmode: "decimal", placeholder: "default" });
  const activate = h("input", { type: "checkbox", checked: true });
  const err = errorBox();
  const form = h(
    "form",
    { class: "card stack", novalidate: true },
    h("h3", {}, "Create user"),
    h(
      "div",
      { class: "grid cols-2" },
      field("Email", email),
      field("Full name", name),
      field("Phone (optional)", phone),
      field("Telegram username (optional)", telegram),
      field("Password (optional)", password, "Leave empty to email the user a link to set their own password."),
      field("Commission % (optional)", commission),
    ),
    h("label", { class: "check" }, activate, "Activate now (skip the approval queue)"),
    err,
    h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "submit" }, "Create user"), btn("Cancel", () => onDone())),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    try {
      const r = await callFunction("admin-actions", {
        body: {
          action: "create_user",
          email: email.value.trim(),
          full_name: name.value.trim(),
          phone: phone.value.trim() || null,
          telegram_username: telegram.value.trim() || null,
          password: password.value || null,
          commission_pct: commission.value.trim() === "" ? null : Number(commission.value),
          activate: activate.checked,
        },
      });
      toast(`User created${r.activated ? " and activated" : ""}${r.password_email_sent ? " · set-password email sent" : ""}`);
      onDone();
    } catch (e2) {
      showError(err, e2);
    }
  });
  queueMicrotask(() => enhancePasswords(form));
  return form;
}

// ---------------------------------------------------------------------------
async function renderLinks(panel) {
  const { data, error } = await db().from("payment_links").select("*, profiles(email)").order("created_at", { ascending: false }).limit(500);
  if (error) throw error;
  const reload = () => renderLinks(panel);
  fill(panel, 
    table(
      [
        { label: "Link", value: (l) => h("a", { href: `/${l.slug}`, target: "_blank", rel: "noopener" }, `/${l.slug}`) },
        { label: "Display name", value: (l) => l.display_name },
        { label: "Owner", value: (l) => l.profiles?.email ?? "—" },
        { label: "Range", value: (l) => `${l.min_usd ? formatUsd(l.min_usd) : "min"} – ${l.max_usd ? formatUsd(l.max_usd) : "max"}` },
        { label: "State", value: (l) => (l.disabled_by_admin ? h("span", { class: "badge bad", title: l.disabled_reason ?? "" }, "disabled by admin") : l.is_active ? badge("active") : h("span", { class: "badge" }, "inactive")) },
        {
          label: "Actions",
          value: (l) =>
            l.disabled_by_admin
              ? btn("Enable", () => act(() => rpc("admin_set_link_disabled", { p_link: l.id, p_disabled: false }), reload))
              : btn("Disable", async () => {
                const reason = await ask({ title: `Disable /${l.slug}?`, label: "Reason", required: true, danger: true, confirmText: "Disable" });
                if (reason) act(() => rpc("admin_set_link_disabled", { p_link: l.id, p_disabled: true, p_reason: reason }), reload);
              }, "btn-danger"),
        },
      ],
      data ?? [],
      { empty: "No links yet." },
    ),
  );
}

// ---------------------------------------------------------------------------
async function renderPayments(panel) {
  const status = h("select", {}, h("option", { value: "" }, "All statuses"), ["pending", "settled", "expired", "failed"].map((s) => h("option", { value: s }, s)));
  const search = h("input", { type: "search", placeholder: "Receipt, slug or email" });
  const results = h("div");
  const load = async () => {
    let q = db().from("payments").select(PAYMENT_SELECT).order("created_at", { ascending: false }).limit(500);
    if (status.value) q = q.eq("status", status.value);
    const { data, error } = await q;
    if (error) throw error;
    const term = search.value.trim().toLowerCase();
    const rows = (data ?? []).filter((p) =>
      !term || receiptId(p.id).toLowerCase().includes(term) || (p.payment_links?.slug ?? "").includes(term) || (p.profiles?.email ?? "").toLowerCase().includes(term)
    );
    fill(results, 
      table(
        [
          { label: "Created", value: (p) => fmtDateTime(p.created_at) },
          { label: "Receipt", value: (p) => h("span", { class: "mono" }, receiptId(p.id)) },
          { label: "Link", value: (p) => `/${p.payment_links?.slug ?? "?"}` },
          { label: "User", value: (p) => p.profiles?.email ?? "—" },
          { label: "Gross", value: (p) => formatUsd(p.amount_usd), num: true },
          { label: "Comm.", value: (p) => `${formatUsd(p.commission_usd)} (${Number(p.commission_pct)}%)`, num: true },
          { label: "Net", value: (p) => formatUsd(p.net_usd), num: true },
          { label: "Sats", value: (p) => Number(p.amount_sats).toLocaleString("en-US"), num: true },
          { label: "Status", value: (p) => badge(p.status) },
          { label: "Domain", value: (p) => p.domain ?? "—" },
          {
            label: "",
            value: (p) =>
              p.status === "pending" || p.status === "expired"
                ? btn("Mark settled", async () => {
                  const reason = await ask({
                    title: `Mark ${receiptId(p.id)} settled?`,
                    body: "Only for reconciliation after confirming the payment on the node. Amounts are never edited.",
                    label: "Audit reason",
                    required: true,
                  });
                  if (reason) act(() => rpc("admin_mark_payment_settled", { p_payment: p.id, p_reason: reason }), load);
                })
                : null,
          },
        ],
        rows,
        { empty: "No payments match." },
      ),
    );
  };
  fill(panel, 
    h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), load()) }, h("div", { class: "field" }, search), h("div", { class: "field" }, status), h("button", { class: "btn btn-secondary", type: "submit" }, "Filter")),
    h("p"),
    results,
  );
  await load();
}

// ---------------------------------------------------------------------------
// Invoices: issue a Lightning invoice on a user's link, manage open invoices, and the
// daily statements (create, run, mark paid out, reopen). Amounts are never edited.
// ---------------------------------------------------------------------------
function invoiceUrl(host, slug, paymentId) {
  const origin = host === location.host ? location.origin : `https://${host}`;
  return `${origin}/${slug}?i=${paymentId}`;
}

async function createInvoiceCard(onCreated) {
  const [users, domains] = await Promise.all([
    activeUsers(),
    db().from("site_domains").select("hostname").eq("is_active", true).order("hostname"),
  ]);
  const hosts = [...new Set([location.host, ...(domains.data ?? []).map((d) => d.hostname)])];
  const user = h("select", {}, h("option", { value: "" }, "Choose a user…"), users.map((u) => h("option", { value: u.id }, `${u.full_name || "—"} · ${u.email}`)));
  const link = h("select", { disabled: true }, h("option", { value: "" }, "Choose a user first"));
  const amount = h("input", { inputmode: "decimal", placeholder: "0.00" });
  const memo = h("input", { maxlength: 140, placeholder: "Shown to the payer, e.g. Order #42" });
  const host = h("select", {}, hosts.map((x) => h("option", { value: x }, x)));
  const err = errorBox();
  const result = h("div");
  let links = [];

  user.addEventListener("change", async () => {
    const { data } = await db().from("payment_links").select("id, slug, display_name, is_active, disabled_by_admin, min_usd, max_usd").eq("user_id", user.value).order("created_at");
    links = (data ?? []).filter((l) => l.is_active && !l.disabled_by_admin);
    fill(link, links.length ? links.map((l) => h("option", { value: l.id }, `/${l.slug} · ${l.display_name}`)) : h("option", { value: "" }, "No active links"));
    link.disabled = !links.length;
  });

  const form = h(
    "form",
    { class: "card stack", novalidate: true },
    h("h3", {}, "Create invoice"),
    h("p", { class: "muted small" }, "Issues a 1-hour Lightning invoice on one of the user's links (same limits, rate and commission as checkout) and gives you a link that opens straight to the QR code."),
    h("div", { class: "grid cols-2" }, field("User", user), field("Payment link", link), field("Amount (USD)", amount), field("Note for the payer (optional)", memo), field("Domain for the link", host)),
    err,
    h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "submit" }, "Create invoice")),
    result,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const cents = parseAmountCents(amount.value);
    if (!link.value) return showError(err, { code: "link_not_found" });
    if (cents === null || cents <= 0) return showError(err, { code: "amount_invalid" });
    try {
      const inv = await callFunction("admin-actions", {
        body: { action: "create_invoice", link_id: link.value, amount_usd: (cents / 100).toFixed(2), memo: memo.value.trim() || null },
      });
      const url = invoiceUrl(host.value, inv.slug, inv.payment_id);
      fill(
        result,
        h(
          "div",
          { class: "result-box stack" },
          h("strong", {}, `${formatUsd(inv.amount_usd)} · ${Number(inv.amount_sats).toLocaleString("en-US")} sats · expires ${fmtDateTime(inv.expires_at)}`),
          h("div", { class: "row between" }, h("span", { class: "mono small" }, url), h("div", { class: "row" }, btn("Copy link", () => copyText(url)), h("a", { class: "btn btn-ghost btn-sm", href: url, target: "_blank", rel: "noopener" }, "Open"))),
        ),
      );
      amount.value = "";
      memo.value = "";
      onCreated();
    } catch (e2) {
      showError(err, e2);
    }
  });
  return form;
}

async function openInvoicesTable(onChange) {
  const { data, error } = await db().from("payments").select(PAYMENT_SELECT).eq("status", "pending").order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  return table(
    [
      { label: "Created", value: (p) => fmtDateTime(p.created_at) },
      { label: "User", value: (p) => p.profiles?.email ?? "—" },
      { label: "Link", value: (p) => `/${p.payment_links?.slug ?? "?"}` },
      { label: "Amount", value: (p) => formatUsd(p.amount_usd), num: true },
      { label: "Note", value: (p) => h("span", {}, p.memo ?? "", p.issued_by ? h("span", { class: "badge" }, " admin") : null) },
      { label: "Expires", value: (p) => (new Date(p.expires_at) < new Date() ? h("span", { class: "badge expired" }, "past expiry") : fmtDateTime(p.expires_at)) },
      {
        label: "",
        value: (p) =>
          h(
            "div",
            { class: "row" },
            btn("Copy link", () => copyText(invoiceUrl(location.host, p.payment_links?.slug ?? "", p.id))),
            btn("Cancel", async () => {
              const ok = await ask({ title: `Cancel ${formatUsd(p.amount_usd)} invoice?`, body: "The node cancels it, so it can no longer be paid. If it was paid a moment ago, it is recorded as settled instead.", danger: true, confirmText: "Cancel invoice" });
              if (!ok) return;
              act(
                () => callFunction("admin-actions", { body: { action: "cancel_invoice", payment_id: p.id } }),
                onChange,
                (r) => (r.status === "settled" ? "It was already paid; recorded as settled." : "Invoice cancelled."),
              );
            }, "btn-danger"),
          ),
      },
    ],
    data ?? [],
    { empty: "No open invoices." },
  );
}

async function statementsSection(onChange) {
  const users = await activeUsers();
  const runDate = h("input", { type: "date" });
  const createUser = h("select", {}, h("option", { value: "" }, "User…"), users.map((u) => h("option", { value: u.id }, u.email)));
  const createDate = h("input", { type: "date" });
  const statusFilter = h("select", {}, ["outstanding", "all", "open", "closed", "paid_out"].map((s) => h("option", { value: s }, s === "outstanding" ? "Outstanding (closed)" : s)));
  const search = h("input", { type: "search", placeholder: "Email" });
  const results = h("div");

  const load = async () => {
    let q = db().from("daily_invoices").select("*, profiles(email)").order("cycle_date", { ascending: false }).limit(300);
    const s = statusFilter.value === "outstanding" ? "closed" : statusFilter.value;
    if (s !== "all") q = q.eq("status", s);
    const { data, error } = await q;
    if (error) throw error;
    const term = search.value.trim().toLowerCase();
    const rows = (data ?? []).filter((d) => !term || (d.profiles?.email ?? "").toLowerCase().includes(term));
    const total = rows.reduce((sum, d) => sum + Number(d.net_usd), 0);
    fill(
      results,
      h("p", { class: "hint" }, `${rows.length} statement(s) · net ${formatUsd(total)}`),
      table(
        [
          { label: "Cycle", value: (d) => fmtDate(d.cycle_date) },
          { label: "User", value: (d) => d.profiles?.email ?? "—" },
          { label: "Payments", value: (d) => String(d.payment_count), num: true },
          { label: "Gross", value: (d) => formatUsd(d.gross_usd), num: true },
          { label: "Commission", value: (d) => formatUsd(d.commission_usd), num: true },
          { label: "Net", value: (d) => formatUsd(d.net_usd), num: true },
          { label: "Status", value: (d) => badge(d.status) },
          { label: "Reference / note", value: (d) => [d.payout_reference, d.admin_note].filter(Boolean).join(" · ") },
          {
            label: "",
            value: (d) =>
              h(
                "div",
                { class: "row" },
                d.status === "closed"
                  ? btn("Mark paid out", async () => {
                    const ref = await ask({ title: `Mark ${formatUsd(d.net_usd)} paid out`, label: "Payout reference", required: true });
                    if (ref) act(() => rpc("admin_update_statement", { p_statement: d.id, p_status: "paid_out", p_reference: ref }), load);
                  }, "btn-primary")
                  : null,
                d.status === "paid_out"
                  ? btn("Reopen", async () => {
                    const why = await ask({ title: "Reopen this statement?", label: "Reason", required: true, danger: true, confirmText: "Reopen" });
                    if (why) act(() => rpc("admin_update_statement", { p_statement: d.id, p_status: "closed", p_note: why }), load);
                  })
                  : null,
                btn("Note", async () => {
                  const note = await ask({ title: "Add a note", label: "Note", required: true });
                  if (note) act(() => rpc("admin_update_statement", { p_statement: d.id, p_note: note }), load);
                }, "btn-ghost"),
              ),
          },
        ],
        rows,
        { empty: "No statements match." },
      ),
    );
  };
  statusFilter.addEventListener("change", load);

  const section = h(
    "div",
    { class: "stack" },
    h("h2", {}, "Daily statements"),
    h(
      "div",
      { class: "grid cols-2" },
      h(
        "div",
        { class: "card stack" },
        h("h3", {}, "Run settlement (19:00 → 19:00 Dhaka)"),
        h("p", { class: "muted small" }, "Cron runs at 19:05 Dhaka. Leave the date empty for the most recently completed cycle."),
        h("div", { class: "row" }, field("Cycle date (ends 19:00 on this date)", runDate), btn("Run now", () =>
          act(
            () => rpc("admin_run_daily_settlement", { p_cycle_date: runDate.value || null }),
            () => (load(), onChange()),
            (rows) => `${rows} statement(s) generated`,
          ), "btn-primary")),
      ),
      h(
        "div",
        { class: "card stack" },
        h("h3", {}, "Create statement for one user"),
        h("p", { class: "muted small" }, "Builds (or rebuilds) that user's statement for the cycle from their settled payments, even if there were none."),
        h("div", { class: "row" }, field("User", createUser), field("Cycle date", createDate), btn("Create", () => {
          if (!createUser.value || !createDate.value) return toast("Choose a user and a date");
          act(() => rpc("admin_create_statement", { p_user: createUser.value, p_cycle_date: createDate.value }), () => (load(), onChange()));
        })),
      ),
    ),
    h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), load()) }, h("div", { class: "field" }, statusFilter), h("div", { class: "field" }, search), h("button", { class: "btn btn-secondary", type: "submit" }, "Filter")),
    results,
  );
  await load();
  return section;
}

async function renderInvoices(panel) {
  const openSlot = h("div");
  const refreshOpen = async () => fill(openSlot, await openInvoicesTable(refreshOpen));
  const [create, statements] = await Promise.all([createInvoiceCard(refreshOpen), statementsSection(() => {})]);
  await refreshOpen();
  fill(panel, h("div", { class: "stack" }, create, h("h2", {}, "Open invoices"), openSlot, statements));
}

// ---------------------------------------------------------------------------
// Payment methods (payout rails). Names appear only inside the dashboard and admin panel.
// ---------------------------------------------------------------------------
const METHOD_ID_RE = /^[a-z0-9_]{2,32}$/;
const FIELD_KEY_RE = /^[a-z0-9_]{1,32}$/;

function validateMethods(methods) {
  const ids = new Set();
  for (const m of methods) {
    if (!METHOD_ID_RE.test(m.id)) return `Method id "${m.id}" must be 2–32 lowercase letters, digits or _`;
    if (ids.has(m.id)) return `Method id "${m.id}" is used twice`;
    ids.add(m.id);
    if (!m.label.trim() || m.label.length > 60) return `Method "${m.id}" needs a label (max 60)`;
    if (!m.fields.length || m.fields.length > 6) return `Method "${m.id}" needs 1–6 fields`;
    const keys = new Set();
    for (const f of m.fields) {
      if (!FIELD_KEY_RE.test(f.key)) return `Field key "${f.key}" in "${m.id}" must be lowercase letters, digits or _`;
      if (keys.has(f.key)) return `Field key "${f.key}" is used twice in "${m.id}"`;
      keys.add(f.key);
      if (!f.label.trim() || f.label.length > 60) return `Field "${f.key}" in "${m.id}" needs a label (max 60)`;
    }
  }
  return null;
}

async function renderMethods(panel) {
  const [{ data: setting }, { data: dests }] = await Promise.all([
    db().from("app_settings").select("value").eq("key", "payout_methods").maybeSingle(),
    db().from("payout_destinations").select("method"),
  ]);
  const saved = new Set((setting?.value ?? []).map((m) => m.id));
  const usage = new Map();
  for (const d of dests ?? []) usage.set(d.method, (usage.get(d.method) ?? 0) + 1);
  const methods = (setting?.value ?? []).map((m) => ({
    id: m.id, label: m.label, enabled: m.enabled !== false, fields: (m.fields ?? []).map((f) => ({ key: f.key, label: f.label })),
  }));
  const err = errorBox();
  const list = h("div", { class: "grid cols-2" });

  const input = (value, onInput, attrs = {}) => {
    const el = h("input", { value, ...attrs });
    el.addEventListener("input", () => onInput(el.value));
    return el;
  };

  const draw = () => {
    fill(
      list,
      methods.map((m, mi) =>
        h(
          "div",
          { class: "card stack method-card" },
          h("div", { class: "row between" }, h("strong", { class: "mono" }, m.id || "new method"), h("span", { class: "faint small" }, `${usage.get(m.id) ?? 0} saved destination(s)`)),
          h(
            "div",
            { class: "grid cols-2" },
            field("Id", input(m.id, (v) => (m.id = v.trim()), { disabled: saved.has(m.id) && usage.get(m.id) ? true : null, placeholder: "wallet_a" })),
            field("Label shown to users", input(m.label, (v) => (m.label = v), { maxlength: 60 })),
          ),
          h("label", { class: "check" }, (() => {
            const cb = h("input", { type: "checkbox", checked: m.enabled });
            cb.addEventListener("change", () => (m.enabled = cb.checked));
            return cb;
          })(), "Enabled (users can add destinations and withdraw with it)"),
          h("p", { class: "hint" }, "Fields users fill in:"),
          m.fields.map((f, fi) =>
            h(
              "div",
              { class: "field-row" },
              field("Key", input(f.key, (v) => (f.key = v.trim()), { placeholder: "account" })),
              field("Label", input(f.label, (v) => (f.label = v), { placeholder: "Account number", maxlength: 60 })),
              btn("Remove", () => (m.fields.splice(fi, 1), draw()), "btn-ghost"),
            )
          ),
          h(
            "div",
            { class: "row" },
            m.fields.length < 6 ? btn("Add field", () => (m.fields.push({ key: "", label: "" }), draw())) : null,
            btn("Delete method", async () => {
              const used = usage.get(m.id) ?? 0;
              if (used) {
                const ok = await ask({ title: `Delete "${m.label}"?`, body: `${used} saved destination(s) use it and will stop working. Disabling it is usually better.`, danger: true, confirmText: "Delete anyway" });
                if (!ok) return;
              }
              methods.splice(mi, 1);
              draw();
            }, "btn-danger"),
          ),
        )
      ),
    );
  };

  const save = () => {
    err.hidden = true;
    const problem = validateMethods(methods);
    if (problem) {
      err.textContent = problem;
      err.hidden = false;
      return;
    }
    const value = methods.map((m) => ({ id: m.id, label: m.label.trim(), enabled: m.enabled, fields: m.fields.map((f) => ({ key: f.key, label: f.label.trim() })) }));
    act(() => rpc("admin_set_setting", { p_key: "payout_methods", p_value: value }), () => renderMethods(panel));
  };

  draw();
  fill(
    panel,
    h("p", { class: "muted" }, "Payout methods users can withdraw with. Their names appear only inside the logged-in dashboard and this panel, never on public pages. Disable a method to stop new withdrawals without breaking saved destinations."),
    list,
    err,
    h("div", { class: "row" }, btn("Add method", () => (methods.push({ id: "", label: "", enabled: true, fields: [{ key: "account", label: "Account number" }] }), draw())), btn("Save methods", save, "btn-primary")),
  );
}

// ---------------------------------------------------------------------------
async function renderWithdrawals(panel) {
  const { data, error } = await db().from("withdrawals").select("*, profiles!withdrawals_user_id_fkey(email, full_name)").order("created_at", { ascending: false }).limit(300);
  if (error) throw error;
  const reload = () => renderWithdrawals(panel);
  const open = (data ?? []).filter((w) => w.status === "requested" || w.status === "approved");
  const done = (data ?? []).filter((w) => !open.includes(w));
  const details = (w) => {
    const snap = w.destination_snapshot ?? {};
    return h("div", {}, h("strong", {}, `${snap.label ?? "—"} · ${w.method}`),
      h("div", { class: "mono small muted" }, Object.entries(snap.details ?? {}).map(([k, v]) => `${k}: ${v}`).join("  ")));
  };
  const reject = (w) => async () => {
    const reason = await ask({ title: `Reject ${formatUsd(w.amount_usd)}?`, label: "Reason (shown to the user)", required: true, danger: true, confirmText: "Reject" });
    if (reason) act(() => rpc("admin_decide_withdrawal", { p_withdrawal: w.id, p_action: "reject", p_reason: reason }), reload);
  };
  const columns = (withActions) => [
    { label: "Requested", value: (w) => fmtDateTime(w.created_at) },
    { label: "User", value: (w) => w.profiles?.email ?? "—" },
    { label: "Amount", value: (w) => formatUsd(w.amount_usd), num: true },
    { label: "Destination", value: details },
    { label: "Status", value: (w) => badge(w.status) },
    withActions
      ? {
        label: "Actions",
        value: (w) =>
          h(
            "div",
            { class: "row" },
            w.status === "requested" ? btn("Approve", () => act(() => rpc("admin_decide_withdrawal", { p_withdrawal: w.id, p_action: "approve" }), reload), "btn-primary") : null,
            w.status === "approved"
              ? btn("Mark paid", async () => {
                const ref = await ask({ title: `Mark ${formatUsd(w.amount_usd)} paid`, label: "Payment reference", required: true });
                if (ref) act(() => rpc("admin_decide_withdrawal", { p_withdrawal: w.id, p_action: "paid", p_reference: ref }), reload);
              }, "btn-primary")
              : null,
            btn("Reject", reject(w), "btn-danger"),
          ),
      }
      : { label: "Reference / reason", value: (w) => w.reference || w.reason || "" },
  ];
  fill(panel, 
    h("h2", {}, `Queue (${open.length})`),
    table(columns(true), open, { empty: "Nothing to process." }),
    h("h2", {}, "History"),
    table(columns(false), done, { empty: "No history yet." }),
  );
}

// ---------------------------------------------------------------------------
async function renderDomains(panel) {
  const { data, error } = await db().from("site_domains").select("*").order("hostname");
  if (error) throw error;
  const reload = () => renderDomains(panel);
  const host = h("input", { placeholder: "pay.example.com" });
  const label = h("input", { placeholder: "Label" });
  fill(panel, 
    h("p", { class: "muted" }, "Links resolve only on active hostnames. Each hostname must also be attached to both Workers (see docs/RUNBOOK.md)."),
    table(
      [
        { label: "Hostname", value: (d) => h("span", { class: "mono" }, d.hostname) },
        { label: "Label", value: (d) => d.label || "—" },
        { label: "Active", value: (d) => (d.is_active ? badge("active") : h("span", { class: "badge" }, "inactive")) },
        { label: "", value: (d) => btn(d.is_active ? "Deactivate" : "Activate", () => act(() => rpc("admin_upsert_domain", { p_hostname: d.hostname, p_label: d.label, p_is_active: !d.is_active }), reload)) },
      ],
      data ?? [],
      { empty: "No domains yet." },
    ),
    h("form", {
      class: "card row",
      onsubmit: (e) => {
        e.preventDefault();
        act(() => rpc("admin_upsert_domain", { p_hostname: host.value.trim(), p_label: label.value.trim(), p_is_active: true }), reload);
      },
    }, h("div", { class: "field" }, host), h("div", { class: "field" }, label), h("button", { class: "btn btn-primary", type: "submit" }, "Add domain")),
  );
}

// ---------------------------------------------------------------------------
const SETTINGS = [
  { key: "checkout_enabled", type: "bool", help: "Master switch for invoice creation. Keep off until the go-live $10 test passes." },
  { key: "min_usd", type: "number", help: "Global minimum per payment (USD)." },
  { key: "max_usd", type: "number", help: "Global maximum per payment (USD)." },
  { key: "invoice_expiry_seconds", type: "number", help: "60–3600. Hard-capped at 3600." },
  { key: "default_commission_pct", type: "number", help: "Used when a user has no individual rate." },
  { key: "withdrawal_min_usd", type: "number", help: "Minimum withdrawal amount." },
  { key: "withdrawal_auto_approve_enabled", type: "bool", help: "Auto-approve small withdrawals (off by default)." },
  { key: "withdrawal_auto_approve_below_usd", type: "number", help: "Auto-approve threshold (inclusive)." },
  { key: "quick_amounts_default", type: "json", help: "Default quick amounts for new links." },
  { key: "max_links_per_user", type: "number", help: "" },
  { key: "telegram_bot_username", type: "text", help: "Bot username without @." },
  { key: "support_contact", type: "text", help: "Shown to rejected/suspended users." },
  { key: "admin_require_mfa", type: "bool", help: "Require a two-factor (aal2) session for every admin RPC. Set up two-factor in Dashboard → Settings first; switching this on is refused from a session without it." },
  { key: "rate_limit_ip_per_min", type: "number", help: "create-invoice calls per IP per minute." },
  { key: "rate_limit_link_per_min", type: "number", help: "create-invoice calls per link per minute." },
  { key: "rate_limit_status_per_min", type: "number", help: "payment-status calls per IP per minute." },
];

async function renderSettings(panel) {
  const { data, error } = await db().from("app_settings").select("*");
  if (error) throw error;
  const values = new Map((data ?? []).map((r) => [r.key, r.value]));
  const rows = SETTINGS.map((s) => {
    const v = values.get(s.key);
    const input = s.type === "bool"
      ? h("input", { type: "checkbox", checked: v === true })
      : s.type === "json"
      ? Object.assign(h("textarea", { rows: 3, class: "mono" }), { value: JSON.stringify(v ?? null, null, 0) })
      : h("input", { value: v ?? "", inputmode: s.type === "number" ? "decimal" : null });
    const save = () => {
      let value;
      try {
        value = s.type === "bool" ? input.checked : s.type === "number" ? Number(input.value) : s.type === "json" ? JSON.parse(input.value) : input.value.trim();
      } catch {
        toast("Invalid JSON");
        return;
      }
      act(() => rpc("admin_set_setting", { p_key: s.key, p_value: value }));
    };
    return h("div", { class: "card tight" }, h("div", { class: "row between" }, h("strong", { class: "mono" }, s.key), btn("Save", save)), h("div", { class: "field" }, input), s.help ? h("p", { class: "hint" }, s.help) : null);
  });

  const tgOut = h("pre", { class: "mono small muted" });
  const tg = (action) => async () => {
    try {
      tgOut.textContent = JSON.stringify(await callFunction("admin-actions", { body: { action } }), null, 2);
    } catch (err) {
      tgOut.textContent = errorText(err);
    }
  };

  fill(panel, 
    h("p", { class: "notice warn" }, t("adm.mfaHint")),
    h("div", { class: "grid cols-2" }, rows),
    h(
      "div",
      { class: "card stack" },
      h("h3", {}, "Telegram bot"),
      h("p", { class: "muted small" }, "Registers the webhook with the secret header (TELEGRAM_WEBHOOK_SECRET). Connect your own Telegram in Dashboard → Settings to receive admin alerts."),
      h("div", { class: "row" }, btn("Register webhook", tg("telegram_set_webhook")), btn("Webhook info", tg("telegram_webhook_info")), btn("Send me a test", tg("telegram_test"))),
      tgOut,
    ),
  );
}

// ---------------------------------------------------------------------------
async function renderNode(panel) {
  const s = await callFunction("node-status", { method: "GET" });
  if (!s.reachable) {
    fill(panel, h("p", { class: "notice bad" }, "LND is not reachable through the tunnel. Check cloudflared, Access service token and LND REST."));
    return;
  }
  const sats = (n) => (n === null || n === undefined ? "—" : `${Number(n).toLocaleString("en-US")} sat`);
  fill(panel, 
    h(
      "div",
      { class: "grid cols-4" },
      stat("Synced", s.synced_to_chain && s.synced_to_graph ? "Yes" : "No", `chain ${s.synced_to_chain ? "✓" : "✗"} · graph ${s.synced_to_graph ? "✓" : "✗"}`),
      stat("Active channels", String(s.num_active_channels), `${s.num_inactive_channels} inactive · ${s.num_pending_channels} pending`),
      stat("Inbound liquidity", sats(s.inbound_liquidity_sat), "remote balance"),
      stat("Local balance", sats(s.local_balance_sat)),
    ),
    h("dl", { class: "kv card" }, h("dt", {}, "Alias"), h("dd", {}, s.alias ?? "—"), h("dt", {}, "Version"), h("dd", {}, s.version ?? "—"), h("dt", {}, "Block height"), h("dd", {}, String(s.block_height ?? "—")), h("dt", {}, "Peers"), h("dd", {}, String(s.num_peers))),
  );
}

// ---------------------------------------------------------------------------
async function renderAudit(panel) {
  const [{ data, error }, people] = await Promise.all([
    db().from("audit_log").select("*").order("created_at", { ascending: false }).limit(300),
    db().from("profiles").select("id, email"),
  ]);
  if (error) throw error;
  const email = new Map((people.data ?? []).map((p) => [p.id, p.email]));
  const short = (v) => (v ? JSON.stringify(v) : "");
  fill(panel, 
    table(
      [
        { label: "When", value: (a) => fmtDateTime(a.created_at) },
        { label: "Actor", value: (a) => email.get(a.actor_id) ?? (a.actor_id ? a.actor_id.slice(0, 8) : "system") },
        { label: "Action", value: (a) => h("span", { class: "mono" }, a.action) },
        { label: "Target", value: (a) => `${a.target_table ?? ""} ${a.target_id ?? ""}`.trim() || "—" },
        { label: "Before → after", value: (a) => h("span", { class: "mono small" }, `${short(a.before)} → ${short(a.after)}`) },
        { label: "Reason", value: (a) => a.reason ?? "" },
      ],
      data ?? [],
      { empty: "No admin actions yet." },
    ),
  );
}

const RENDER = {
  overview: renderOverview,
  approvals: renderApprovals,
  users: renderUsers,
  links: renderLinks,
  payments: renderPayments,
  invoices: renderInvoices,
  withdrawals: renderWithdrawals,
  methods: renderMethods,
  domains: renderDomains,
  settings: renderSettings,
  node: renderNode,
  audit: renderAudit,
};

async function boot() {
  me = await requireActive(app, { admin: true });
  if (!me) return;
  const isAdmin = await rpc("is_admin");
  app.replaceChildren(h("div", { class: "page-head" }, h("h1", {}, t("adm.title"))));
  if (!isAdmin) {
    // role=admin, but admin_require_mfa is on and this session is not aal2. A session with an
    // enrolled factor was already asked for its code by requireActive(), so none is set up yet.
    const aal = await sessionAal();
    app.append(
      h(
        "div",
        { class: "card stack" },
        h("h2", {}, "Two-factor authentication required"),
        h("p", { class: "muted" }, `Admin access needs a session verified with an authenticator code (this session: ${aal ?? "unknown"}). Set up two-factor in your dashboard settings, then come back.`),
        h("div", { class: "row" }, h("a", { class: "btn btn-primary", href: "/dashboard#settings" }, "Set up two-factor"), btn("I've set it up", () => location.reload())),
      ),
    );
    return;
  }
  tabs(app, TABS, (id) => t(`adm.tab.${id}`), (id, panel) => RENDER[id](panel));
}

boot().catch((err) => app.replaceChildren(h("p", { class: "notice bad" }, errorText(err))));
