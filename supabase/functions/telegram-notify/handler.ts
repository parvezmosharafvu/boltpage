import { errorResponse, HttpError, json } from "../_shared/http.ts";
import type { SendResult } from "../_shared/telegram.ts";

export interface OutboxMessage {
  id: number;
  chat_id: number;
  body: string;
}

export interface NotifyDeps {
  isAuthorized(req: Request): boolean;
  token: string | undefined;
  claim(limit: number): Promise<OutboxMessage[]>;
  complete(id: number, ok: boolean, error: string | null, retry: boolean): Promise<void>;
  send(token: string, chatId: number, text: string): Promise<SendResult>;
}

// Cron (every minute): drain the Telegram outbox.
export function createHandler(deps: NotifyDeps) {
  return async (req: Request): Promise<Response> => {
    try {
      if (!deps.isAuthorized(req)) throw new HttpError(401, "unauthorized");
      if (!deps.token) throw new HttpError(503, "telegram_not_configured");

      const messages = await deps.claim(50);
      const summary = { sent: 0, failed: 0, retry: 0 };
      // Sequential keeps us far below Telegram's per-bot rate limits.
      for (const m of messages) {
        const r = await deps.send(deps.token, m.chat_id, m.body);
        await deps.complete(m.id, r.ok, r.ok ? null : r.error ?? "send failed", r.retryable);
        if (r.ok) summary.sent++;
        else if (r.retryable) summary.retry++;
        else summary.failed++;
      }
      return json(summary);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
