import { requireAdmin, requireEnv, serviceClient } from "../_shared/auth.ts";
import { dbError } from "../_shared/http.ts";
import { sendTelegramMessage, telegramApi } from "../_shared/telegram.ts";
import { createHandler } from "./handler.ts";

const token = Deno.env.get("TELEGRAM_BOT_TOKEN");

Deno.serve(createHandler({
  async authenticateAdmin(req) {
    const admin = await requireAdmin(req);
    return {
      userId: admin.id,
      async rpc(fn, args) {
        const { data, error } = await admin.client.rpc(fn, args);
        if (error) throw dbError(error);
        return data;
      },
    };
  },
  async adminChatId(userId) {
    const { data } = await serviceClient().from("profiles").select("telegram_chat_id").eq("id", userId).maybeSingle();
    return data?.telegram_chat_id ?? null;
  },
  telegram: {
    token,
    webhookSecret: Deno.env.get("TELEGRAM_WEBHOOK_SECRET"),
    webhookUrl: `${requireEnv("SUPABASE_URL")}/functions/v1/telegram-webhook`,
    call: (method, payload) => telegramApi(token ?? "", method, payload),
    send: (chatId, text) => sendTelegramMessage(token ?? "", chatId, text),
  },
}));
