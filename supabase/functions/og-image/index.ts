// GET ?slug=<slug>&v=<version> -> 1200x630 PNG. The preview Worker proxies and caches this
// under a versioned file name, so a year-long cache is safe and edits bust it.
import { ImageResponse } from "https://deno.land/x/og_edge@0.0.4/mod.ts";
import { serviceClient } from "../_shared/auth.ts";
import { brandName } from "../_shared/deps.ts";
import { linkCard } from "./card.ts";

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

  const image = new ImageResponse(linkCard(link.display_name, link.note, brandName()), { width: 1200, height: 630 });
  return new Response(image.body, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
