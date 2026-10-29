// Admin panel. Every write is an audited SECURITY DEFINER RPC that re-checks is_admin()
// (role + active + aal2 when admin_require_mfa is on); this UI is only a convenience.
import { t } from "./i18n.js";
import { formatUsd, h, receiptId } from "./core.js";
import { callFunction, errorText, getClient, requireActive, rpc, signOut } from "./auth.js";
import { ask, badge, field, fill, fmtDate, fmtDateTime, stat, table, tabs, toast } from "./ui.js";

const app = document.getElementById("app");
const db = () => getClient();
const TABS = ["approvals", "users", "links", "payments", "settlement", "withdrawals", "domains", "settings", "node", "audit"];
let me = null;

document.getElementById("logout").addEventListener("click", signOut);

// Runs an admin action, reports the outcome, then re-renders the tab.
async function act(fn, done, okMessage = t("common.saved")) {
  try {
    await fn();
    toast(okMessage);
    done?.();
  } catch (err) {
    toast(errorText(err));
  }
}

const btn = (label, onclick, cls = "btn-secondary") =>
  h("button", { class: `btn ${cls} btn-sm`, type: "button", onclick }, label);

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
  fill(panel, 
    h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), load()) }, h("div", { class: "field" }, search), h("div", { class: "field" }, status), h("button", { class: "btn btn-secondary", type: "submit" }, "Search")),
    h("p"),
    results,
  );
  await load();
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
    let q = db().from("payments").select("*, payment_links(slug), profiles(email)").order("created_at", { ascending: false }).limit(500);
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
async function renderSettlement(panel) {
  const date = h("input", { type: "date" });
  const { data, error } = await db().from("daily_invoices").select("*, profiles(email)").order("cycle_date", { ascending: false }).limit(300);
  if (error) throw error;
  const reload = () => renderSettlement(panel);
  fill(panel, 
    h(
      "div",
      { class: "card stack" },
      h("h3", {}, "Daily settlement (19:00 → 19:00 Asia/Dhaka)"),
      h("p", { class: "muted small" }, "Cron runs at 19:05 Dhaka. Run now regenerates a cycle idempotently; leave the date empty for the most recently completed cycle, or pick today's cycle date for a provisional open statement."),
      h("div", { class: "row" }, field("Cycle date (ends 19:00 on this date)", date), btn("Run now", () =>
        act(async () => {
          const rows = await rpc("admin_run_daily_settlement", { p_cycle_date: date.value || null });
          toast(`${rows} statement(s) generated`);
        }, reload, "Done"), "btn-primary")),
    ),
    h("h2", {}, "Statements"),
    table(
      [
        { label: "Cycle", value: (d) => fmtDate(d.cycle_date) },
        { label: "User", value: (d) => d.profiles?.email ?? "—" },
        { label: "Payments", value: (d) => String(d.payment_count), num: true },
        { label: "Gross", value: (d) => formatUsd(d.gross_usd), num: true },
        { label: "Commission", value: (d) => formatUsd(d.commission_usd), num: true },
        { label: "Net", value: (d) => formatUsd(d.net_usd), num: true },
        { label: "Status", value: (d) => badge(d.status) },
        { label: "", value: (d) => (d.status === "closed" ? btn("Mark paid out", () => act(() => rpc("admin_mark_statement_paid", { p_statement: d.id }), reload)) : null) },
      ],
      data ?? [],
      { empty: "No statements yet." },
    ),
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
  { key: "payout_methods", type: "json", help: 'Shown only inside the dashboard. [{"id":"wallet_a","label":"…","fields":[{"key":"account","label":"Account"}]}]' },
  { key: "quick_amounts_default", type: "json", help: "Default quick amounts for new links." },
  { key: "max_links_per_user", type: "number", help: "" },
  { key: "telegram_bot_username", type: "text", help: "Bot username without @." },
  { key: "support_contact", type: "text", help: "Shown to rejected/suspended users." },
  { key: "admin_require_mfa", type: "bool", help: "Require an aal2 (TOTP) session for every admin RPC. Enroll MFA first!" },
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
  approvals: renderApprovals,
  users: renderUsers,
  links: renderLinks,
  payments: renderPayments,
  settlement: renderSettlement,
  withdrawals: renderWithdrawals,
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
    // role=admin but no aal2 session while admin_require_mfa is on.
    app.append(h("p", { class: "notice bad" }, "Admin access requires a two-factor (aal2) session. Sign in again with your authenticator code."));
    return;
  }
  tabs(app, TABS, (id) => t(`adm.tab.${id}`), (id, panel) => RENDER[id](panel));
}

boot().catch((err) => app.replaceChildren(h("p", { class: "notice bad" }, errorText(err))));
