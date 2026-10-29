import { brandName, rpc } from "../_shared/deps.ts";
import { sendTelegramMessage } from "../_shared/telegram.ts";
import { createHandler, type LinkResult } from "./handler.ts";

const token = Deno.env.get("TELEGRAM_BOT_TOKEN");

Deno.serve(createHandler({
  secret: Deno.env.get("TELEGRAM_WEBHOOK_SECRET"),
  linkChat: (code, chatId, username) =>
    rpc<LinkResult>("telegram_link_chat", { p_code: code, p_chat_id: chatId, p_username: username }),
  unlinkChat: (chatId) => rpc<boolean>("telegram_unlink_chat", { p_chat_id: chatId }),
  async reply(chatId, text) {
    if (token) await sendTelegramMessage(token, chatId, text);
  },
  brandName: brandName(),
}));
