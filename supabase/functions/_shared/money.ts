// Integer-cent and integer-sat arithmetic. No floats touch an amount after parsing.

const USD_RE = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

// Accepts "10", "10.5", "10.50" or the numbers 10 / 10.5. Rejects more than 2 decimals,
// exponents, negatives and zero. Returns cents, or null when invalid.
export function parseUsdCents(input: unknown): bigint | null {
  let text: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    text = String(input);
  } else if (typeof input === "string") {
    text = input.trim();
  } else {
    return null;
  }
  const m = USD_RE.exec(text);
  if (!m) return null;
  const cents = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  return cents > 0n ? cents : null;
}

export function formatCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

// sats = usd / (usd per btc) * 1e8, computed as cents * 1e8 / rate_cents, rounded half up.
export function usdCentsToSats(cents: bigint, btcUsd: number): bigint {
  if (!Number.isFinite(btcUsd) || btcUsd <= 0) {
    throw new Error("invalid BTC/USD rate");
  }
  const rateCents = BigInt(Math.round(btcUsd * 100));
  return (cents * 100_000_000n * 2n + rateCents) / (2n * rateCents);
}

// Mirrors SQL round(gross * pct / 100, 2) (half away from zero) for previews and tests.
// pct is given with at most 2 decimals, e.g. 5 or 2.5.
export function commissionCents(grossCents: bigint, pct: number): bigint {
  const pctBp = BigInt(Math.round(pct * 100)); // basis points of a percent: 5% -> 500
  return (grossCents * pctBp * 2n + 10_000n) / 20_000n;
}
