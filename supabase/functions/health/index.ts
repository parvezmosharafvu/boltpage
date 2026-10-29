import { serviceClient } from "../_shared/auth.ts";
import { hasCronSecret } from "../_shared/cron.ts";
import { getLnd, rpc } from "../_shared/deps.ts";
import { createHandler } from "./handler.ts";

Deno.serve(createHandler({
  async checkDb() {
    const { error } = await serviceClient().from("app_settings").select("key").limit(1);
    return !error;
  },
  async checkLnd() {
    const info = await getLnd().getInfo();
    return { reachable: true, synced: Boolean(info?.synced_to_chain) && Boolean(info?.synced_to_graph) };
  },
  isCron: (req) => hasCronSecret(req),
  async alertAdmins(text, dedupeKey) {
    await rpc("notify_admins", { p_kind: "health", p_body: text, p_dedupe: dedupeKey });
  },
}));
