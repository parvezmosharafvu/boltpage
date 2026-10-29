// Acceptance 4 (client side) and 6 (deeplink, polling cadence) at the unit level.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatCountdown, formatUsd, launchUrl, lightningUri, parseAmountCents, parseQuickAmounts, pollDelay, qrPayload,
  receiptId, toCsv, validateAmount,
} from "../../public/core.js";

test("amount limits: $9.99 and $1000.01 rejected, $10 and $1000 accepted", () => {
  assert.deepEqual(validateAmount("9.99", 10, 1000), { ok: false, code: "amount_below_min" });
  assert.deepEqual(validateAmount("1000.01", 10, 1000), { ok: false, code: "amount_above_max" });
  assert.equal(validateAmount("10", 10, 1000).amount, "10.00");
  assert.equal(validateAmount("1000", 10, 1000).amount, "1000.00");
  assert.equal(validateAmount("$1,000.00", 10, 1000).ok, true);
});

test("link-level narrower range is enforced", () => {
  assert.equal(validateAmount("19.99", 20, 200).code, "amount_below_min");
  assert.equal(validateAmount("200.01", 20, 200).code, "amount_above_max");
  assert.equal(validateAmount("20", 20, 200).ok, true);
});

test("at most two decimals, no junk", () => {
  for (const bad of ["10.001", "abc", "", "-5", "1e3", "0", "10.", ".5"]) {
    assert.equal(validateAmount(bad, 10, 1000).ok, false, bad);
  }
  assert.equal(parseAmountCents("12.3"), 1230);
});

test("deeplinks and QR payload", () => {
  const bolt11 = "lnbc150u1pjtestinvoice";
  assert.equal(launchUrl(bolt11), `https://cash.app/launch/lightning/${encodeURIComponent(bolt11)}`);
  assert.equal(lightningUri(bolt11), "lightning:lnbc150u1pjtestinvoice");
  assert.equal(qrPayload(bolt11), "LIGHTNING:LNBC150U1PJTESTINVOICE");
});

test("poll every 3 s, 10 s while the tab is hidden", () => {
  assert.equal(pollDelay(false), 3000);
  assert.equal(pollDelay(true), 10000);
});

test("formatting helpers", () => {
  assert.equal(formatUsd(1000), "$1,000.00");
  assert.equal(formatCountdown(3600_000), "60:00");
  assert.equal(formatCountdown(61_500), "01:02");
  assert.equal(formatCountdown(-5), "00:00");
  assert.equal(receiptId("8329fd47-bc67-4f20-bc14-d6b2dd57a9bb"), "8329FD47");
  assert.deepEqual(parseQuickAmounts("50, 10 25,10"), [10, 25, 50]);
  assert.equal(parseQuickAmounts("10, x"), null);
});

test("CSV export quotes and neutralises formulas", () => {
  const csv = toCsv(
    [{ label: "link", value: (r) => r.link }, { label: "net", value: (r) => r.net }],
    [{ link: '=HYPERLINK("x")', net: "9.50" }, { link: "a,b", net: "1" }],
  );
  assert.equal(csv, 'link,net\r\n"\'=HYPERLINK(""x"")",9.50\r\n"a,b",1\r\n');
});
