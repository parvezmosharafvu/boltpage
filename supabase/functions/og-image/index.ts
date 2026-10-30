// GET ?slug=<slug>&v=<version> -> 1200x630 PNG. The preview Worker proxies and caches this
// under a versioned file name, so a year-long cache is safe and edits bust it.
import { serviceClient } from "../_shared/auth.ts";
import { brandName } from "../_shared/deps.ts";
import { renderLinkCard } from "./render.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response(null, { status: 405 });
  const url = new URL(req.url);
  const slug = (url.searchParams.get("slug") ?? "").toLowerCase();
  if (!SLUG_RE.test(slug)) return new Response("not found", { status: 404 });

  const { data, error } = await serviceClient().rpc("public_link_by_slug", { p_slug: slug, p_hostname: null });
  const link = !error && Array.isArray(data) ? data[0] : null;
  if (!link) {
    return new Response("not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
  }

  try {
    const png = await renderLinkCard(link.display_name, link.note, brandName());
    return new Response(png, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    // The preview Worker falls back to the static default image on any non-200.
    console.error("og render failed:", err instanceof Error ? err.message : String(err));
    return new Response("render failed", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
});
