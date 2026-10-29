import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { commissionCents, formatCents, parseUsdCents, usdCentsToSats } from "../_shared/money.ts";
import { cachedRate, fetchBtcUsd, type RateSource } from "../_shared/rate.ts";
import { jsonResponse, mockFetch } from "./helpers.ts";

Deno.test("parseUsdCents accepts at most two decimals", () => {
  assertEquals(parseUsdCents("10"), 1000n);
  assertEquals(parseUsdCents("10.5"), 1050n);
  assertEquals(parseUsdCents(" 1000.00 "), 100000n);
  assertEquals(parseUsdCents(9.99), 999n);
  assertEquals(parseUsdCents("10.001"), null);
  assertEquals(parseUsdCents(0.1 + 0.2), null);
  assertEquals(parseUsdCents("-5"), null);
  assertEquals(parseUsdCents("0"), null);
  assertEquals(parseUsdCents("1e3"), null);
  assertEquals(parseUsdCents(null), null);
  assertEquals(formatCents(100001n), "1000.01");
  assertEquals(formatCents(5n), "0.05");
});

Deno.test("USD -> sats at a given rate, rounded half up", () => {
  assertEquals(usdCentsToSats(1000n, 50_000), 20_000n); // $10 at $50k
  assertEquals(usdCentsToSats(100000n, 66_666.67), 1_500_000n); // $1000
  assertEquals(usdCentsToSats(1000n, 66_666.67), 15_000n);
});

Deno.test("commission matches SQL round(gross * pct / 100, 2)", () => {
  assertEquals(commissionCents(10000n, 5), 500n); // $100 at 5% -> $5.00
  assertEquals(commissionCents(3333n, 5), 167n); // $33.33 -> 1.6665 -> 1.67
  assertEquals(commissionCents(1000n, 2.5), 25n);
});

Deno.test("rate is the median of sane sources", async () => {
  const sources: RateSource[] = [
    { name: "a", url: "https://a.test/", pick: (b) => b.v },
    { name: "b", url: "https://b.test/", pick: (b) => b.v },
    { name: "c", url: "https://c.test/", pick: (b) => b.v },
    { name: "bad", url: "https://bad.test/", pick: (b) => b.v },
    { name: "down", url: "https://down.test/", pick: (b) => b.v },
  ];
  const values: Record<string, unknown> = { a: "60000", b: "61000.5", c: 59000, bad: "12" };
  const { fetchImpl } = mockFetch((c) =>
    c.url.hostname === "down.test" ? new Response("x", { status: 500 }) : jsonResponse({ v: values[c.url.hostname.split(".")[0]] })
  );
  const quote = await fetchBtcUsd(fetchImpl, sources);
  assertEquals(quote.rate, 60000);
  assertEquals(quote.sources.sort(), ["a", "b", "c"]);
});

Deno.test("rate fetch fails when no source answers", async () => {
  const { fetchImpl } = mockFetch(() => new Response("down", { status: 503 }));
  await assertRejects(() => fetchBtcUsd(fetchImpl), Error, "no_rate_source");
});

Deno.test("cached rate is reused for at most 60 s from the upstream fetch time", async () => {
  let t = 1_000_000;
  let loads = 0;
  const get = cachedRate(async () => {
    loads++;
    return { rate: 50_000 + loads, sources: ["x"], fetchedAt: t - 30_000 }; // already 30 s old (DB cache)
  }, 60_000, () => t);
  assertEquals((await get()).rate, 50_001);
  t += 29_000;
  assertEquals((await get()).rate, 50_001);
  t += 2_000; // 61 s since upstream fetch
  assertEquals((await get()).rate, 50_002);
  assertEquals(loads, 2);
});
