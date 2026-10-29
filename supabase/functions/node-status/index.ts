import { requireAdmin } from "../_shared/auth.ts";
import { getLnd } from "../_shared/deps.ts";
import { createHandler } from "./handler.ts";

Deno.serve(createHandler({
  authenticateAdmin: requireAdmin,
  getInfo: () => getLnd().getInfo(),
  channelBalance: () => getLnd().channelBalance(),
}));
