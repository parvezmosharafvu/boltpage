import { requireUser } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/deps.ts";
import { dbError } from "../_shared/http.ts";
import { createHandler, type Withdrawal } from "./handler.ts";

Deno.serve(createHandler({
  async authenticate(req) {
    const user = await requireUser(req);
    return {
      userId: user.id,
      async requestWithdrawal(amountUsd, destinationId) {
        const { data, error } = await user.client.rpc("request_withdrawal", {
          p_amount_usd: amountUsd,
          p_destination_id: destinationId,
        });
        if (error) throw dbError(error);
        return data as Withdrawal;
      },
    };
  },
  rateLimit,
}));
