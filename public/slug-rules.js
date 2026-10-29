// Payment link slug rules. Shared by the checkout page, the dashboard and the preview Worker.
// RESERVED_SLUGS must match public.reserved_slugs (tests/unit/slug-rules.test.mjs checks).

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export const RESERVED_SLUGS = new Set([
  "404", "about", "account", "admin", "api", "app", "assets", "auth", "billing",
  "blog", "config", "contact", "dashboard", "docs", "favicon", "functions", "health",
  "help", "i18n", "index", "invoice", "invoices", "login", "logout", "mail", "pay",
  "payment", "payments", "privacy", "register", "reset", "rest", "robots", "root",
  "settings", "signin", "signout", "signup", "sitemap", "static", "status", "styles",
  "support", "telegram", "terms", "vendor", "withdraw", "www",
]);

export function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_RE.test(slug) && !slug.includes("--") && !RESERVED_SLUGS.has(slug);
}

// "/alice", "/alice/", "/pay/alice" -> "alice"; anything else -> null.
export function slugFromPath(pathname) {
  const m = /^\/(?:pay\/)?([^/]+)\/?$/.exec(pathname || "");
  if (!m) return null;
  let slug;
  try {
    slug = decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return null;
  }
  return isValidSlug(slug) ? slug : null;
}
