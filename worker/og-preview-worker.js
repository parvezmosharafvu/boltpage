// Link-preview Worker. Runs as a route on every site hostname, in front of the static site.
//  - Crawler user agents on /<slug> or /pay/<slug> get small OG HTML ("Pay <name>").
//  - /og/<slug>.v<version>t<template>.png proxies the og-image function and caches it for a
//    year (the version changes whenever the link is edited, so the cache never goes stale).
//  - Everything else passes straight through to the static site.
import { slugFromPath } from "../public/slug-rules.js";

const CRAWLER_RE =
  /facebookexternalhit|facebot|twitterbot|whatsapp|telegrambot|slackbot|slack-imgproxy|discordbot|linkedinbot|pinterest|skypeuripreview|redditbot|embedly|iframely|vkshare|applebot|googlebot|bingbot|mastodon|signal|viber/i;
const OG_IMAGE_RE = /^\/og\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\.v(\d{1,12})t(\d{1,4})\.png$/;
const OG_TEMPLATE_VERSION = "1";
export const HOME_IMAGE = "/assets/og/og-home-v1.png";
export const DEFAULT_IMAGE = "/assets/og/og-default-v1.png";
const DEFAULT_DESCRIPTION = "Pay securely in seconds with any Lightning wallet.";

export function isCrawler(userAgent) {
  return CRAWLER_RE.test(userAgent ?? "");
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function ogHtml({ title, description, url, image, siteName }) {
  const e = escapeHtml;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} · ${e(siteName)}</title>
<meta name="description" content="${e(description)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${e(siteName)}">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:url" content="${e(url)}">
<meta property="og:image" content="${e(image)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(description)}">
<meta name="twitter:image" content="${e(image)}">
</head>
<body><h1>${e(title)}</h1><p>${e(description)}</p><p><a href="${e(url)}">${e(url)}</a></p></body>
</html>`;
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function apiHeaders(env) {
  const key = env.SUPABASE_ANON_KEY ?? "";
  return key.startsWith("sb_publishable_")
    ? { apikey: key, "Content-Type": "application/json" }
    : { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function lookupLink(env, slug, hostname) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/public_link_by_slug`, {
    method: "POST",
    headers: apiHeaders(env),
    body: JSON.stringify({ p_slug: slug, p_hostname: hostname }),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function ogImage(request, env, ctx, slug, version) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;

  const upstream = await fetch(`${env.SUPABASE_URL}/functions/v1/og-image?slug=${slug}&v=${version}`);
  if (!upstream.ok || !(upstream.headers.get("content-type") ?? "").startsWith("image/png")) {
    return fetch(new URL(DEFAULT_IMAGE, request.url));
  }
  const res = new Response(upstream.body, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") return fetch(request);
    const url = new URL(request.url);
    const brand = env.BRAND_NAME || "Boltpage";

    const image = OG_IMAGE_RE.exec(url.pathname);
    if (image) return ogImage(request, env, ctx, image[1], `${image[2]}t${image[3]}`);

    if (!isCrawler(request.headers.get("user-agent"))) return fetch(request);

    if (url.pathname === "/") {
      return htmlResponse(ogHtml({
        title: "Get paid in seconds",
        description: "Share one payment link. Customers pay from any Lightning wallet and you see it land instantly.",
        url: url.origin + "/",
        image: url.origin + HOME_IMAGE,
        siteName: brand,
      }));
    }

    const slug = slugFromPath(url.pathname);
    if (!slug) return fetch(request); // static pages and assets

    const link = await lookupLink(env, slug, url.hostname);
    if (!link) {
      return htmlResponse(ogHtml({
        title: "Page not found",
        description: DEFAULT_DESCRIPTION,
        url: url.origin + url.pathname,
        image: url.origin + DEFAULT_IMAGE,
        siteName: brand,
      }), 404);
    }
    return htmlResponse(ogHtml({
      title: `Pay ${link.display_name}`,
      description: link.note || DEFAULT_DESCRIPTION,
      url: url.origin + url.pathname,
      image: `${url.origin}/og/${slug}.v${link.og_version}t${OG_TEMPLATE_VERSION}.png`,
      siteName: brand,
    }));
  },
};
