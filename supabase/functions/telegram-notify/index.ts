import { hasCronSecret } from "../_shared/cron.ts";
import { rpc } from "../_shared/deps.ts";
import { sendTelegramMessage } from "../_shared/telegram.ts";
import { createHandler, type OutboxMessage } from "./handler.ts";

Deno.serve(createHandler({
  isAuthorized: (req) => hasCronSecret(req),
  token: Deno.env.get("TELEGRAM_BOT_TOKEN"),
  claim: (limit) => rpc<OutboxMessage[]>("claim_notifications", { p_limit: limit }),
  async complete(id, ok, error, retry) {
    await rpc("complete_notification", { p_id: id, p_ok: ok, p_error: error, p_retry: retry });
  },
  send: (token, chatId, text) => sendTelegramMessage(token, chatId, text),
}));
