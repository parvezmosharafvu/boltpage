// Acceptance 14 and 15: the checker passes on the repo and catches what it should.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { decodePng, greenShare, scanCopy, scanSecrets } from "../../ci/check_public_copy.mjs";

const script = fileURLToPath(new URL("../../ci/check_public_copy.mjs", import.meta.url));

test("the repository's public files pass", () => {
  const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(out, /public check passed/);
});

test("forbidden payout words are caught (English and Bangla)", () => {
  for (const word of ["bKash", "Nagad", "Binance Pay", "bank transfer", "Breez", "Spark", "বিকাশ", "নগদ"]) {
    assert.equal(scanCopy("x.html", `<p>Withdraw with ${word}</p>`).length, 1, word);
  }
  assert.deepEqual(scanCopy("x.js", "sparkline breeze"), []);
});

test("Cash App only as the button label", () => {
  assert.deepEqual(scanCopy("x.js", '"pay.openDeeplink": "Open in Cash App", url: "https://cash.app/launch/lightning/"'), []);
  assert.equal(scanCopy("x.html", "Get paid from Cash App").length, 1);
  assert.equal(scanCopy("x.html", "Your CashApp balance").length, 1);
});

test("Cash App green in CSS and PNG pixels is caught", () => {
  assert.equal(scanCopy("x.css", ".btn { background: #00D632 }").length, 1);
  assert.equal(scanCopy("x.css", ".btn { color: rgb(0, 214, 50) }").length, 1);
  assert.deepEqual(scanCopy("x.css", ".btn { background: #FFB800 }"), []);

  // 2x1 RGB PNG: one green pixel, one amber pixel.
  const raw = Buffer.from([0, 0x00, 0xd6, 0x32, 0xff, 0xb8, 0x00]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  assert.equal(greenShare(decodePng(png)), 0.5);
});

test("secrets are caught", () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const serviceJwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "service_role", iss: "x" })}.c2lnbmF0dXJlLXRlc3Q`;
  const anonJwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "anon", iss: "x" })}.c2lnbmF0dXJlLXRlc3Q`;
  assert.equal(scanSecrets("config.js", `key: "${serviceJwt}"`).length, 1);
  assert.deepEqual(scanSecrets("config.js", `key: "${anonJwt}"`), []);
  assert.equal(scanSecrets("x.js", "0201036c6e6402f801030a10" + "ab".repeat(20)).length, 1);
  assert.equal(scanSecrets("x.js", "sb_secret_" + "x".repeat(24)).length, 1);
});
