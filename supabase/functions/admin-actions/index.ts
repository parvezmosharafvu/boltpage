import { requireAdmin, requireEnv, serviceClient, telegramWebhookSecret } from "../_shared/auth.ts";
import { getLnd, transitionStore } from "../_shared/deps.ts";
import { dbError, HttpError } from "../_shared/http.ts";
import { issueInvoice } from "../_shared/invoice.ts";
import { issueDeps } from "../_shared/invoice_deps.ts";
import { sendTelegramMessage, telegramApi } from "../_shared/telegram.ts";
import { createHandler } from "./handler.ts";

const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
const webhookSecret = await telegramWebhookSecret();

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, "") + "Aa1!";
}

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
    webhookSecret,
    webhookUrl: `${requireEnv("SUPABASE_URL")}/functions/v1/telegram-webhook`,
    call: (method, payload) => telegramApi(token ?? "", method, payload),
    send: (chatId, text) => sendTelegramMessage(token ?? "", chatId, text),
  },
  invoices: {
    async create({ linkId, cents, memo, adminId }) {
      const { data: link } = await serviceClient().from("payment_links").select("slug").eq("id", linkId).maybeSingle();
      if (!link) throw new HttpError(404, "link_not_found");
      const invoice = await issueInvoice(issueDeps, { slug: link.slug, cents, hostname: null, memo, issuedBy: adminId });
      return { ...invoice, slug: link.slug };
    },
    async cancel(paymentId) {
      const { data: p } = await serviceClient()
        .from("payments")
        .select("payment_hash, status")
        .eq("id", paymentId)
        .maybeSingle();
      if (!p) throw new HttpError(404, "not_found");
      if (p.status !== "pending") throw new HttpError(409, "invoice_not_open");
      const lnd = getLnd();
      try {
        await lnd.cancelInvoice(p.payment_hash);
      } catch (err) {
        // Already settled/canceled at LND, or a transient error: the lookup below decides.
        console.error("cancelInvoice:", err instanceof Error ? err.message : String(err));
      }
      const inv = await lnd.lookupInvoice(p.payment_hash);
      if (inv?.state === "SETTLED") {
        await transitionStore.settle(p.payment_hash, inv.settleDate, inv.amtPaidSat, "status");
        return "settled";
      }
      if (inv && inv.state !== "CANCELED") throw new HttpError(502, "cancel_failed");
      await transitionStore.expire(p.payment_hash);
      return "expired";
    },
  },
  users: {
    async create(user, siteOrigin) {
      const db = serviceClient();
      const { data, error } = await db.auth.admin.createUser({
        email: user.email,
        password: user.password ?? randomPassword(),
        email_confirm: true,
        user_metadata: { full_name: user.fullName, phone: user.phone, telegram_username: user.telegramUsername },
      });
      if (error || !data?.user) {
        throw /already|registered|exists/i.test(error?.message ?? "") ? new HttpError(409, "email_taken") : new HttpError(500, "internal_error");
      }
      let passwordEmailSent = false;
      if (!user.password && siteOrigin) {
        // Only send people to one of our own active domains.
        const host = new URL(siteOrigin).hostname;
        const { data: domain } = await db.from("site_domains").select("hostname").eq("hostname", host).eq("is_active", true).maybeSingle();
        if (domain) {
          const { error: mailError } = await db.auth.resetPasswordForEmail(user.email, { redirectTo: `${siteOrigin}/reset` });
          passwordEmailSent = !mailError;
        }
      }
      return { userId: data.user.id, passwordEmailSent };
    },
  },
}));
