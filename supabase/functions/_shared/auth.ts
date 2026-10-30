import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { HttpError } from "./http.ts";

export type { SupabaseClient };

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

// Prefer the `default` sb_secret_/sb_publishable_ key (JSON maps injected into every function);
// the legacy JWT keys are the fallback and stop working at the end of 2026.
function apiKey(keysEnv: string, legacyEnv: string): string {
  const keys = Deno.env.get(keysEnv);
  if (keys) {
    try {
      const key = (JSON.parse(keys) as Record<string, unknown>).default;
      if (typeof key === "string" && key) return key;
    } catch {
      // fall through to the legacy key
    }
  }
  return requireEnv(legacyEnv);
}

export const serviceKey = () => apiKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
export const publicKey = () => apiKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");

// Secrets the operator may set, otherwise derived from the service key so a fresh project works
// without copying random values around. Rotating the service key changes them (rate-limit buckets
// reset; register the Telegram webhook again).
export function ipHashSalt(): string {
  return Deno.env.get("IP_HASH_SALT") || serviceKey();
}

export async function telegramWebhookSecret(): Promise<string> {
  const set = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (set) return set;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`telegram-webhook:${serviceKey()}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

let service: SupabaseClient | null = null;

// Service role bypasses RLS: use only for the narrow service RPCs each function needs.
export function serviceClient(): SupabaseClient {
  service ??= createClient(requireEnv("SUPABASE_URL"), serviceKey(), noSession);
  return service;
}

// Acts as the calling user, so RLS and auth.uid() inside RPCs apply (audit actor = caller).
export function userClient(authorization: string): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), publicKey(), {
    ...noSession,
    global: { headers: { Authorization: authorization } },
  });
}

export interface CallingUser {
  id: string;
  client: SupabaseClient;
}

export async function requireUser(req: Request): Promise<CallingUser> {
  const authorization = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  if (!token) {
    throw new HttpError(401, "unauthorized");
  }
  const client = userClient(authorization);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) {
    throw new HttpError(401, "unauthorized");
  }
  return { id: data.user.id, client };
}

export async function requireAdmin(req: Request): Promise<CallingUser> {
  const user = await requireUser(req);
  const { data, error } = await user.client.rpc("is_admin");
  if (error || data !== true) {
    throw new HttpError(403, "not_authorized");
  }
  return user;
}
