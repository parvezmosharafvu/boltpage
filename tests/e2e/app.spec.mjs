// Logged-in flows against the mock backend: admin overview, admin invoices (+ the ?i= checkout
// link), statements, payment methods, admin user creation, user reports, two-factor.
// Mock-only demo logins (tests/e2e/mock-server.mjs); TOTP code 123456 verifies.
import { expect, test } from "@playwright/test";

const PASSWORD = "demo-password";
const shot = async (page, name) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });
};

// Signs in from a clean session. Waits for the redirect unless a second factor is expected.
async function login(page, email, { expectMfa = false } = {}) {
  await page.goto("/terms"); // static page: no auth redirects while we clear storage
  await page.evaluate(() => localStorage.clear());
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  if (!expectMfa) await page.waitForURL(/\/(admin|dashboard)/);
}

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

test("password fields have a show/hide toggle", async ({ page }) => {
  await page.goto("/login");
  const pw = page.getByLabel("Password", { exact: true });
  await pw.fill("secret-value");
  await expect(pw).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(pw).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(pw).toHaveAttribute("type", "password");
});

test("admin overview: revenue incl. commission, payable, success rate", async ({ page }) => {
  await login(page, "admin@demo.test");
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  for (const label of ["Revenue today", "Revenue this month", "Commission all time", "Payable to users", "Success rate (month)", "Open withdrawals"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Top users this month" })).toBeVisible();
  await shot(page, "admin-overview");
});

test("admin issues an invoice; its link opens straight to the QR and settles", async ({ page, request }) => {
  await login(page, "admin@demo.test");
  await page.goto("/admin#invoices");
  await page.getByLabel("User", { exact: true }).first().selectOption({ label: "Rahim Uddin · seller@demo.test" });
  await expect(page.getByLabel("Payment link")).toBeEnabled();
  await page.getByLabel("Amount (USD)").fill("75");
  await page.getByLabel("Note for the payer (optional)").fill("Order #42");
  await page.getByRole("button", { name: "Create invoice" }).click();
  const url = await page.locator(".result-box .mono").textContent();
  expect(url).toMatch(/\/demo\?i=[0-9a-f-]{36}$/);
  await expect(page.getByText("Order #42").first()).toBeVisible(); // listed under open invoices
  await shot(page, "admin-invoices");

  await page.goto(url);
  await expect(page.locator("#view-invoice")).toBeVisible();
  await expect(page.locator("#inv-usd")).toHaveText("$75.00");
  await expect(page.locator("#inv-memo")).toHaveText("Order #42");
  await expect(page.getByRole("link", { name: "Open in Cash App" })).toHaveAttribute("href", /^https:\/\/cash\.app\/launch\/lightning\/lnbc/);

  await request.post("/__mock/control", { data: { status: "settled" } });
  await expect(page.getByRole("heading", { name: "Payment received" })).toBeVisible({ timeout: 10_000 });
});

test("invoice link with the wrong slug is a neutral 404", async ({ page, request }) => {
  const res = await request.post("/__mock/functions/v1/create-invoice", { data: { slug: "demo", amount_usd: "20" } });
  const { payment_id } = await res.json();
  await page.goto(`/narrow?i=${payment_id}`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("admin cancels an open invoice", async ({ page, request }) => {
  await request.post("/__mock/functions/v1/create-invoice", { data: { slug: "demo", amount_usd: "33", memo: "cancel-me" } });
  await login(page, "admin@demo.test");
  await page.goto("/admin#invoices");
  const row = page.locator("tr", { hasText: "cancel-me" });
  await row.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Cancel invoice" }).click();
  await expect(page.getByText("Invoice cancelled.")).toBeVisible();
  await expect(page.locator("tr", { hasText: "cancel-me" })).toHaveCount(0);
});

test("statements: mark an outstanding statement paid out with a reference", async ({ page }) => {
  await login(page, "admin@demo.test");
  await page.goto("/admin#invoices");
  await expect(page.getByRole("heading", { name: "Daily statements" })).toBeVisible();
  const first = page.locator("tr", { has: page.getByRole("button", { name: "Mark paid out" }) }).first();
  await first.getByRole("button", { name: "Mark paid out" }).click();
  await page.getByLabel("Payout reference").fill("BATCH-9");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
});

test("payment methods editor validates, saves and can disable a method", async ({ page }) => {
  await login(page, "admin@demo.test");
  await page.goto("/admin#methods");
  await expect(page.getByText("wallet_a", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add method" }).click();
  await page.getByRole("button", { name: "Save methods" }).click();
  await expect(page.locator(".error")).toContainText('Method id ""');
  const card = page.locator(".method-card").last();
  await card.getByLabel("Id").fill("wallet_b");
  await card.getByLabel("Label shown to users").fill("Wallet B");
  await card.getByLabel("Enabled (users can add destinations and withdraw with it)").uncheck();
  await page.getByRole("button", { name: "Save methods" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.locator(".method-card")).toHaveCount(2);
  await shot(page, "admin-methods");
});

test("admin creates and activates a user", async ({ page }) => {
  await login(page, "admin@demo.test");
  await page.goto("/admin#users");
  await page.getByRole("button", { name: "Create user" }).first().click();
  await page.getByLabel("Email").fill(`new-${Date.now()}@demo.test`);
  await page.getByLabel("Full name").fill("New Seller");
  await page.getByLabel("Commission % (optional)").fill("4.5");
  await page.locator("form.card").getByRole("button", { name: "Create user" }).click();
  await expect(page.getByText("User created and activated · set-password email sent")).toBeVisible();
});

test("user reports: monthly totals, success rate, recent paid", async ({ page }) => {
  await login(page, "seller@demo.test");
  await expect(page).toHaveURL(/\/dashboard/);
  await page.getByRole("tab", { name: "Reports" }).click();
  for (const label of ["Collected (incl. commission)", "Your earnings", "Success rate"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Most recent paid payments" })).toBeVisible();
  await shot(page, "user-reports");
});

test("two-factor: set up in settings, then login asks for the code", async ({ page }) => {
  await login(page, "seller@demo.test");
  await page.goto("/dashboard#settings");
  await page.getByRole("button", { name: "Set up two-factor" }).click();
  await expect(page.locator("img.mfa-qr")).toBeVisible();
  // The QR image actually decodes (an unencoded "#" in the data URL would break it).
  await expect.poll(() => page.locator("img.mfa-qr").evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByText("JBSWY3DPEHPK3PXP")).toBeVisible();
  await shot(page, "user-mfa-setup");
  await page.getByLabel("6-digit code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("That code didn't work.", { exact: false })).toBeVisible();
  await page.getByLabel("6-digit code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Two-factor authentication is on.").first()).toBeVisible();

  // A fresh login now stops at the code step.
  await login(page, "seller@demo.test", { expectMfa: true });
  await expect(page.getByRole("heading", { name: "Enter your authentication code" })).toBeVisible();
  await page.getByLabel("6-digit code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  // Clean up so other runs start without a factor.
  await page.goto("/dashboard#settings");
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByRole("button", { name: "Set up two-factor" })).toBeVisible();
});
