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

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

let service: SupabaseClient | null = null;

// Service role bypasses RLS: use only for the narrow service RPCs each function needs.
export function serviceClient(): SupabaseClient {
  service ??= createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), noSession);
  return service;
}

// Acts as the calling user, so RLS and auth.uid() inside RPCs apply (audit actor = caller).
export function userClient(authorization: string): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
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
