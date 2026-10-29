import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";
import { parseCommand, verifyWebhookSecret } from "../_shared/telegram.ts";

export type LinkResult = "linked" | "expired" | "invalid";

export interface WebhookDeps {
  secret: string | undefined;
  linkChat(code: string, chatId: number, username: string | null): Promise<LinkResult>;
  unlinkChat(chatId: number): Promise<boolean>;
  reply(chatId: number, text: string): Promise<void>;
  brandName: string;
}

interface Update {
  message?: {
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { username?: string };
  };
}

export function createHandler(deps: WebhookDeps) {
  const replies: Record<LinkResult, string> = {
    linked: `Connected. You will get ${deps.brandName} notifications here. Send /stop to disconnect.`,
    expired: 'This connect code has expired. Open your dashboard and press "Connect Telegram" again.',
    invalid: 'This connect code is not valid. Open your dashboard and press "Connect Telegram" again.',
  };

  return async (req: Request): Promise<Response> => {
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      if (!verifyWebhookSecret(req, deps.secret)) throw new HttpError(403, "forbidden");

      const update = await readJson<Update>(req, 65_536);
      const message = update.message;
      const chatId = message?.chat?.id;
      // Only private chats; ignore groups, channels, edits and everything else.
      if (!message || typeof chatId !== "number" || message.chat?.type !== "private") {
        return json({ ok: true });
      }

      const command = parseCommand(message.text);
      if (command.kind === "start" && command.code) {
        const result = await deps.linkChat(command.code, chatId, message.from?.username ?? null);
        await deps.reply(chatId, replies[result]);
      } else if (command.kind === "start") {
        await deps.reply(chatId, `Hi! To get ${deps.brandName} notifications, press "Connect Telegram" in your dashboard.`);
      } else if (command.kind === "stop") {
        const was = await deps.unlinkChat(chatId);
        await deps.reply(chatId, was ? "Disconnected. You will no longer receive notifications." : "This chat is not connected.");
      } else {
        await deps.reply(chatId, "Use the Connect Telegram button in your dashboard to link this chat. Send /stop to disconnect.");
      }
      return json({ ok: true });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
