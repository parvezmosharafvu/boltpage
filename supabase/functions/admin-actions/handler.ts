import { preflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson, UUID_RE } from "../_shared/http.ts";
import type { IssuedInvoice } from "../_shared/invoice.ts";
import { formatCents, parseUsdCents } from "../_shared/money.ts";
import type { SendResult } from "../_shared/telegram.ts";

// Admin operations that need server-side secrets or the service role. Plain database writes
// (approvals, commission, withdrawals, statements, settings, ...) are audited RPCs the admin
// panel calls directly; every action here is also recorded through admin_record_action.
export interface AdminCaller {
  userId: string;
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface NewUser {
  email: string;
  fullName: string;
  phone: string | null;
  telegramUsername: string | null;
  password: string | null; // null -> random password + "set your password" email
}

export interface AdminDeps {
  authenticateAdmin(req: Request): Promise<AdminCaller>;
  adminChatId(userId: string): Promise<number | null>;
  telegram: {
    token: string | undefined;
    webhookSecret: string | undefined;
    webhookUrl: string;
    // deno-lint-ignore no-explicit-any
    call(method: string, payload: Record<string, unknown>): Promise<any>;
    send(chatId: number, text: string): Promise<SendResult>;
  };
  invoices: {
    // Issues a Lightning invoice on a user's link (same validation and limits as checkout).
    create(input: { linkId: string; cents: bigint; memo: string | null; adminId: string }): Promise<IssuedInvoice & { slug: string }>;
    // Cancels an open invoice at LND, then records the final state.
    cancel(paymentId: string): Promise<"expired" | "settled">;
  };
  users: {
    // Creates the auth user (pending profile via trigger). `siteOrigin` is where the
    // set-password email should land; it must be an active site domain.
    create(input: NewUser, siteOrigin: string | null): Promise<{ userId: string; passwordEmailSent: boolean }>;
  };
}

interface Body {
  action?: string;
  cycle_date?: string;
  link_id?: string;
  amount_usd?: unknown;
  memo?: unknown;
  payment_id?: string;
  email?: unknown;
  full_name?: unknown;
  phone?: unknown;
  telegram_username?: unknown;
  password?: unknown;
  activate?: unknown;
  commission_pct?: unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const TELEGRAM_RE = /^[A-Za-z0-9_]{5,32}$/;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function parseNewUser(body: Body): { user: NewUser; activate: boolean; commission: number | null } {
  const email = str(body.email).toLowerCase();
  const fullName = str(body.full_name);
  const phone = str(body.phone) || null;
  const telegramUsername = str(body.telegram_username).replace(/^@+/, "") || null;
  const password = typeof body.password === "string" && body.password !== "" ? body.password : null;
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "email_invalid");
  if (fullName.length < 1 || fullName.length > 120) throw new HttpError(400, "full_name_invalid");
  if (phone && phone.length > 32) throw new HttpError(400, "phone_invalid");
  if (telegramUsername && !TELEGRAM_RE.test(telegramUsername)) throw new HttpError(400, "telegram_username_invalid");
  if (password !== null && (password.length < 10 || password.length > 72)) throw new HttpError(400, "password_short");
  let commission: number | null = null;
  if (body.commission_pct !== undefined && body.commission_pct !== null && body.commission_pct !== "") {
    // Checked as text: numeric(5,2) allows two decimals, and 1.1 * 100 is not 110 in floating point.
    const raw = String(body.commission_pct).trim();
    commission = Number(raw);
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(raw) || commission > 100) throw new HttpError(400, "commission_invalid");
  }
  return { user: { email, fullName, phone, telegramUsername, password }, activate: body.activate === true, commission };
}

export function createHandler(deps: AdminDeps) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      const admin = await deps.authenticateAdmin(req);
      const body = await readJson<Body>(req);
      const tg = deps.telegram;

      switch (body.action) {
        case "run_settlement": {
          const cycleDate = body.cycle_date || null;
          if (cycleDate && !DATE_RE.test(cycleDate)) throw new HttpError(400, "invalid_cycle_date");
          const rows = await admin.rpc("admin_run_daily_settlement", { p_cycle_date: cycleDate });
          return json({ rows });
        }

        case "create_invoice": {
          const linkId = str(body.link_id);
          if (!UUID_RE.test(linkId)) throw new HttpError(404, "link_not_found");
          const cents = parseUsdCents(body.amount_usd);
          if (cents === null) throw new HttpError(400, "amount_invalid");
          const memo = str(body.memo) || null;
          if (memo && memo.length > 140) throw new HttpError(400, "memo_too_long");
          const invoice = await deps.invoices.create({ linkId, cents, memo, adminId: admin.userId });
          await admin.rpc("admin_record_action", {
            p_action: "invoice.create",
            p_details: { payment_id: invoice.payment_id, link_id: linkId, amount_usd: formatCents(cents), memo },
          });
          return json(invoice);
        }

        case "cancel_invoice": {
          const paymentId = str(body.payment_id);
          if (!UUID_RE.test(paymentId)) throw new HttpError(400, "invalid_id");
          const status = await deps.invoices.cancel(paymentId);
          await admin.rpc("admin_record_action", { p_action: "invoice.cancel", p_details: { payment_id: paymentId, result: status } });
          return json({ status });
        }

        case "create_user": {
          const { user, activate, commission } = parseNewUser(body);
          const created = await deps.users.create(user, req.headers.get("origin"));
          if (activate) await admin.rpc("admin_set_account_status", { p_user: created.userId, p_status: "active" });
          if (commission !== null) await admin.rpc("admin_set_commission", { p_user: created.userId, p_pct: commission });
          await admin.rpc("admin_record_action", {
            p_action: "user.create",
            p_details: { user_id: created.userId, email: user.email, activated: activate, commission_pct: commission },
          });
          return json({ user_id: created.userId, activated: activate, password_email_sent: created.passwordEmailSent });
        }

        case "telegram_set_webhook": {
          if (!tg.token || !tg.webhookSecret) throw new HttpError(503, "telegram_not_configured");
          const r = await tg.call("setWebhook", {
            url: tg.webhookUrl,
            secret_token: tg.webhookSecret,
            allowed_updates: ["message"],
          });
          await admin.rpc("admin_record_action", {
            p_action: "telegram.set_webhook",
            p_details: { url: tg.webhookUrl, ok: Boolean(r?.ok) },
          });
          return json({ ok: Boolean(r?.ok), description: r?.description ?? null });
        }
        case "telegram_webhook_info": {
          if (!tg.token) throw new HttpError(503, "telegram_not_configured");
          const r = await tg.call("getWebhookInfo", {});
          const info = r?.result ?? {};
          return json({
            url: info.url ?? null,
            pending_update_count: info.pending_update_count ?? null,
            last_error_date: info.last_error_date ?? null,
            last_error_message: info.last_error_message ?? null,
          });
        }
        case "telegram_test": {
          if (!tg.token) throw new HttpError(503, "telegram_not_configured");
          const chatId = await deps.adminChatId(admin.userId);
          if (chatId === null) throw new HttpError(400, "telegram_not_connected");
          const r = await tg.send(chatId, "Test message: admin notifications are working.");
          return json({ ok: r.ok });
        }
        default:
          throw new HttpError(400, "unknown_action");
      }
    } catch (err) {
      return errorResponse(err);
    }
  };
}
