import { preflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import type { SendResult } from "../_shared/telegram.ts";

// Admin operations that need server-side secrets. Plain database writes (approvals,
// commission, withdrawals, settings, ...) are audited RPCs the admin panel calls directly.
export interface AdminCaller {
  userId: string;
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown>;
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
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createHandler(deps: AdminDeps) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      const admin = await deps.authenticateAdmin(req);
      const body = await readJson<{ action?: string; cycle_date?: string }>(req);
      const tg = deps.telegram;

      switch (body.action) {
        case "run_settlement": {
          const cycleDate = body.cycle_date || null;
          if (cycleDate && !DATE_RE.test(cycleDate)) throw new HttpError(400, "invalid_cycle_date");
          const rows = await admin.rpc("admin_run_daily_settlement", { p_cycle_date: cycleDate });
          return json({ rows });
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
