import { preflight } from "../_shared/cors.ts";
import { errorResponse, HttpError, json } from "../_shared/http.ts";

export interface NodeStatusDeps {
  authenticateAdmin(req: Request): Promise<unknown>;
  // deno-lint-ignore no-explicit-any
  getInfo(): Promise<any>;
  // deno-lint-ignore no-explicit-any
  channelBalance(): Promise<any>;
}

const sat = (v: unknown): number | null => {
  // deno-lint-ignore no-explicit-any
  const n = Number((v as any)?.sat ?? v);
  return Number.isFinite(n) ? n : null;
};

// Read-only node overview for the admin panel. Inbound liquidity = remote channel balance.
export function createHandler(deps: NodeStatusDeps) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    try {
      if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
      await deps.authenticateAdmin(req);
      try {
        const [info, balance] = await Promise.all([deps.getInfo(), deps.channelBalance()]);
        return json({
          reachable: true,
          alias: info?.alias ?? null,
          version: info?.version ?? null,
          block_height: info?.block_height ?? null,
          synced_to_chain: Boolean(info?.synced_to_chain),
          synced_to_graph: Boolean(info?.synced_to_graph),
          num_active_channels: info?.num_active_channels ?? 0,
          num_inactive_channels: info?.num_inactive_channels ?? 0,
          num_pending_channels: info?.num_pending_channels ?? 0,
          num_peers: info?.num_peers ?? 0,
          local_balance_sat: sat(balance?.local_balance ?? balance?.balance),
          inbound_liquidity_sat: sat(balance?.remote_balance),
          pending_open_local_sat: sat(balance?.pending_open_local_balance ?? balance?.pending_open_balance),
        });
      } catch (err) {
        console.error("node-status failed:", err instanceof Error ? err.message : String(err));
        return json({ reachable: false });
      }
    } catch (err) {
      return errorResponse(err);
    }
  };
}
