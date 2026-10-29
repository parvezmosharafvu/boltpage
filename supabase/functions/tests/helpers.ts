// Test doubles shared by the function tests.

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export function mockFetch(route: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const call: RecordedCall = {
      method: req.method,
      url: new URL(req.url),
      headers: req.headers,
      body: req.method === "GET" ? "" : await req.text(),
    };
    calls.push(call);
    return await route(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function hexToBase64(hex: string): string {
  const bytes = hex.match(/../g)!.map((b) => parseInt(b, 16));
  return btoa(String.fromCharCode(...bytes));
}

// In-memory stand-in for the guarded SQL transitions (status-conditional updates).
export function memoryStore(initial: Record<string, string>) {
  const status = { ...initial };
  const calls: string[] = [];
  const guarded = (hash: string, from: string[], to: string) => {
    calls.push(`${to}:${hash}`);
    if (!from.includes(status[hash])) return Promise.resolve(false);
    status[hash] = to;
    return Promise.resolve(true);
  };
  return {
    status,
    calls,
    settle: (hash: string) => guarded(hash, ["pending", "expired"], "settled"),
    expire: (hash: string) => guarded(hash, ["pending"], "expired"),
    fail: (hash: string) => guarded(hash, ["pending"], "failed"),
  };
}

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);
export const HASH_D = "d".repeat(64);
