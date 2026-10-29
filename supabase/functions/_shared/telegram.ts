import { timingSafeEqual } from "./http.ts";

// Telegram echoes the secret_token given to setWebhook in this header.
// Fails closed: no configured secret means every request is refused.
export function verifyWebhookSecret(req: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  return timingSafeEqual(got, expected);
}

export type BotCommand =
  | { kind: "start"; code: string | null }
  | { kind: "stop" }
  | { kind: "help" };

export function parseCommand(text: string | undefined): BotCommand {
  const t = (text ?? "").trim();
  const start = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/.exec(t);
  if (start) return { kind: "start", code: start[1] ?? null };
  if (/^\/stop(?:@\w+)?$/.test(t)) return { kind: "stop" };
  return { kind: "help" };
}

export interface SendResult {
  ok: boolean;
  retryable: boolean;
  error?: string;
}

// Plain text (no parse_mode), so user-provided names need no escaping.
export async function sendTelegramMessage(
  token: string,
  chatId: number | string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true, retryable: false };
    const body = await res.json().catch(() => ({}));
    // 403: user blocked the bot / chat gone. 400: bad chat id. Neither improves with retries.
    return {
      ok: false,
      retryable: res.status === 429 || res.status >= 500,
      error: `telegram ${res.status}: ${String(body?.description ?? "").slice(0, 200)}`,
    };
  } catch (err) {
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function telegramApi(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return await res.json();
}
