import { preflight } from "../_shared/cors.ts";
import { json } from "../_shared/http.ts";

export interface HealthDeps {
  checkDb(): Promise<boolean>;
  checkLnd(): Promise<{ reachable: boolean; synced: boolean }>;
  isCron(req: Request): boolean;
  alertAdmins(text: string, dedupeKey: string): Promise<void>;
  now?: () => Date;
}

// Public booleans only. When called by cron, a failing check alerts admins at most once an hour.
export function createHandler(deps: HealthDeps) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    const now = deps.now?.() ?? new Date();
    const db = await deps.checkDb().catch(() => false);
    const lnd = await deps.checkLnd().catch(() => ({ reachable: false, synced: false }));
    const ok = db && lnd.reachable && lnd.synced;

    if (!ok && deps.isCron(req)) {
      const hour = now.toISOString().slice(0, 13);
      await deps
        .alertAdmins(
          `Health alert: database ${db ? "ok" : "DOWN"}, LND ${lnd.reachable ? "reachable" : "UNREACHABLE"}, ` +
            `${lnd.synced ? "synced" : "NOT synced"}.`,
          `health:${hour}`,
        )
        .catch((err) => console.error("health alert failed:", err instanceof Error ? err.message : String(err)));
    }

    return json({ ok, db, lnd: lnd.reachable, synced: lnd.synced, time: now.toISOString() }, ok ? 200 : 503);
  };
}
