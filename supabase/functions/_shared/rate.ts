// BTC/USD spot rate: median of several public exchange tickers, cached for <= 60 s.
// See docs/ARCHITECTURE.md ("Exchange rate") for why these sources.

export interface RateQuote {
  rate: number;
  sources: string[];
  fetchedAt?: number; // ms epoch of the upstream fetch; cache age is measured from here
}

export interface RateSource {
  name: string;
  url: string;
  // deno-lint-ignore no-explicit-any
  pick: (body: any) => unknown;
}

export const RATE_SOURCES: RateSource[] = [
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    pick: (b) => b?.data?.amount,
  },
  {
    name: "kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    pick: (b) => {
      const result = b?.result ?? {};
      const key = Object.keys(result)[0];
      return key ? result[key]?.c?.[0] : undefined;
    },
  },
  {
    name: "bitstamp",
    url: "https://www.bitstamp.net/api/v2/ticker/btcusd/",
    pick: (b) => b?.last,
  },
];

const SANE_MIN = 1_000;
const SANE_MAX = 10_000_000;

export async function fetchBtcUsd(
  fetchImpl: typeof fetch = fetch,
  sources: RateSource[] = RATE_SOURCES,
  timeoutMs = 4000,
): Promise<RateQuote> {
  const results = await Promise.all(
    sources.map(async (s) => {
      try {
        const res = await fetchImpl(s.url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const value = Number(s.pick(await res.json()));
        return value > SANE_MIN && value < SANE_MAX ? { name: s.name, value } : null;
      } catch {
        return null;
      }
    }),
  );
  const ok = results.filter((r): r is { name: string; value: number } => r !== null)
    .sort((a, b) => a.value - b.value);
  if (ok.length === 0) {
    throw new Error("no_rate_source");
  }
  const mid = Math.floor(ok.length / 2);
  const median = ok.length % 2 ? ok[mid].value : (ok[mid - 1].value + ok[mid].value) / 2;
  return { rate: Math.round(median * 100) / 100, sources: ok.map((r) => r.name), fetchedAt: Date.now() };
}

// In-memory cache per isolate with single-flight loading. Age is measured from the
// quote's own fetchedAt, so layering it over the shared DB cache never exceeds ttlMs.
export function cachedRate(
  loader: () => Promise<RateQuote>,
  ttlMs = 60_000,
  now: () => number = Date.now,
): () => Promise<RateQuote> {
  let cached: { quote: RateQuote; at: number } | null = null;
  let inflight: Promise<RateQuote> | null = null;
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.quote;
    inflight ??= loader()
      .then((quote) => {
        cached = { quote, at: quote.fetchedAt ?? now() };
        return quote;
      })
      .finally(() => {
        inflight = null;
      });
    return await inflight;
  };
}
