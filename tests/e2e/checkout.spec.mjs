// Acceptance 4 (client side), 6 (checkout UX) and 12 (unknown link -> neutral 404) in a browser,
// against the mock backend in tests/e2e/mock-server.mjs.
import { expect, test } from "@playwright/test";

const control = (request, status) => request.post("/__mock/control", { data: { status } });
const pollCount = async (request) => (await (await request.get("/__mock/state")).json()).polls.length;

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

async function startInvoice(page, amount = "25") {
  await page.getByLabel("Amount (USD)").fill(amount);
  const created = page.waitForResponse((r) => r.url().includes("/functions/v1/create-invoice"));
  await page.getByRole("button", { name: "Continue" }).click();
  const invoice = await (await created).json();
  await expect(page.locator("#view-invoice")).toBeVisible();
  return invoice;
}

test("amount limits are checked before any invoice is created", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: "Rahim's Studio" })).toBeVisible();
  const amount = page.getByLabel("Amount (USD)");
  const error = page.locator("#amount-error");

  await amount.fill("9.99");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(error).toHaveText("The minimum is $10.00.");

  await amount.fill("1000.01");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(error).toHaveText("The maximum is $1,000.00.");

  await amount.fill("10.001");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(error).toContainText("up to 2 decimals");

  await amount.fill("1000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#inv-usd")).toHaveText("$1,000.00");
});

test("a link can narrow the range", async ({ page }) => {
  await page.goto("/pay/narrow");
  await expect(page.locator("#amount-hint")).toHaveText("Between $20.00 and $200.00");
  await expect(page.locator("#chips .chip")).toHaveText(["$25", "$50", "$100"]);
  await page.getByLabel("Amount (USD)").fill("19.99");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#amount-error")).toHaveText("The minimum is $20.00.");
  await page.getByRole("button", { name: "$50" }).click();
  await expect(page.getByLabel("Amount (USD)")).toHaveValue("50.00");
});

test("invoice: QR, deeplinks, 3 s polling, success screen", async ({ page, request }) => {
  await page.clock.install();
  await page.goto("/demo");
  const invoice = await startInvoice(page, "25");

  await expect(page.locator("#inv-usd")).toHaveText("$25.00");
  await expect(page.locator("#inv-sats")).toHaveText(`${invoice.amount_sats.toLocaleString("en-US")} sats`);
  await expect(page.locator("#inv-qr svg path")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Open in Cash App" }))
    .toHaveAttribute("href", "https://cash.app/launch/lightning/" + encodeURIComponent(invoice.bolt11));
  await expect(page.getByRole("link", { name: "Open in wallet" })).toHaveAttribute("href", `lightning:${invoice.bolt11}`);
  await expect(page.locator("#inv-timer")).toHaveText(/^(60:00|59:5\d)$/);

  expect(await pollCount(request)).toBe(0);
  await page.clock.runFor(2900);
  expect(await pollCount(request)).toBe(0);
  await page.clock.runFor(200);
  await expect.poll(() => pollCount(request)).toBe(1);
  await page.clock.runFor(3000);
  await expect.poll(() => pollCount(request)).toBe(2);

  await control(request, "settled");
  await page.clock.runFor(3000);
  await expect(page.getByRole("heading", { name: "Payment received" })).toBeVisible();
  await expect(page.locator("#ok-usd")).toHaveText("$25.00");
  await expect(page.locator("#ok-receipt")).toHaveText(invoice.payment_id.replace(/-/g, "").slice(0, 8).toUpperCase());

  // Terminal state: polling stops.
  const after = await pollCount(request);
  await page.clock.runFor(15_000);
  expect(await pollCount(request)).toBe(after);
});

test("expired invoice offers a new one with the same amount", async ({ page, request }) => {
  await page.clock.install();
  await page.goto("/demo");
  await startInvoice(page, "42.50");
  await control(request, "expired");
  await page.clock.runFor(3000);
  await expect(page.getByRole("heading", { name: "This invoice expired" })).toBeVisible();
  await page.getByRole("button", { name: "Create a new one" }).click();
  await expect(page.getByLabel("Amount (USD)")).toHaveValue("42.50");
});

test("failed invoice shows the failure screen", async ({ page, request }) => {
  await page.clock.install();
  await page.goto("/demo");
  await startInvoice(page, "15");
  await control(request, "failed");
  await page.clock.runFor(3000);
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
});

test("checkout disabled shows a notice and no Continue", async ({ page }) => {
  await page.goto("/off");
  await expect(page.locator("#checkout-off")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
});

test("unknown or reserved paths never show a checkout", async ({ page }) => {
  await page.goto("/nobody-here");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.goto("/a--b");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  const res = await page.goto("/login");
  expect(res.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
});

test("Bangla checkout keeps the factual deeplink label", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "বাংলা" }).click();
  await expect(page.getByRole("button", { name: "এগিয়ে যান" })).toBeVisible();
  await startInvoiceBn(page);
  await expect(page.getByRole("link", { name: "Cash App-এ খুলুন" })).toBeVisible();
});

async function startInvoiceBn(page) {
  await page.locator("#amount").fill("30");
  await page.getByRole("button", { name: "এগিয়ে যান" }).click();
  await expect(page.locator("#view-invoice")).toBeVisible();
}

test("never exposes the creator's private data", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: "Rahim's Studio" })).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain("seller@demo.test");
  expect(html).not.toContain("+8801700000000");
});
