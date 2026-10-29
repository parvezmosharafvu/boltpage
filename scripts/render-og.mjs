// Renders the static, versioned OG images (home + default) in the site's brand.
// Bump the -vN suffix in the file name whenever the design changes so year-long caches bust.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "assets", "og");
const brand = process.env.BRAND_NAME || "Boltpage";
const C = { bg: "#0B0B0C", panel: "#17171B", border: "#2A2A31", accent: "#FFB800", text: "#F5F5F2", muted: "#A3A3AB" };
const FONT = "Segoe UI, Helvetica Neue, Arial, sans-serif";

const bolt = (x, y, s) => `
  <g transform="translate(${x} ${y}) scale(${s / 64})">
    <rect width="64" height="64" rx="16" fill="${C.accent}"/>
    <path d="M36 8 L16 36 H30 L26 56 L48 26 H34 Z" fill="${C.bg}"/>
  </g>`;

const frame = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="0.82" cy="0.18" r="0.7">
      <stop offset="0" stop-color="${C.accent}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${C.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="${C.bg}"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  ${bolt(80, 72, 64)}
  <text x="164" y="118" font-family="${FONT}" font-size="40" font-weight="700" fill="${C.accent}">${brand}</text>
  ${inner}
</svg>`;

const home = frame(`
  <text x="80" y="300" font-family="${FONT}" font-size="92" font-weight="800" fill="${C.text}">Get paid in seconds.</text>
  <text x="80" y="370" font-family="${FONT}" font-size="34" fill="${C.muted}">Share one link. Customers pay from any Lightning wallet.</text>
  <rect x="80" y="450" width="300" height="72" rx="36" fill="${C.accent}"/>
  <text x="230" y="497" text-anchor="middle" font-family="${FONT}" font-size="30" font-weight="700" fill="${C.bg}">Create your link</text>
  <g transform="translate(820 400)">
    <rect width="300" height="150" rx="24" fill="${C.panel}" stroke="${C.border}"/>
    <text x="32" y="58" font-family="${FONT}" font-size="22" fill="${C.muted}">Payment received</text>
    <text x="32" y="112" font-family="${FONT}" font-size="52" font-weight="800" fill="${C.text}">$100.00</text>
  </g>`);

const fallback = frame(`
  <text x="80" y="320" font-family="${FONT}" font-size="88" font-weight="800" fill="${C.text}">Pay in seconds</text>
  <text x="80" y="390" font-family="${FONT}" font-size="34" fill="${C.muted}">Secure payment link · any Lightning wallet</text>
  <rect x="80" y="470" width="220" height="68" rx="34" fill="${C.accent}"/>
  <text x="190" y="515" text-anchor="middle" font-family="${FONT}" font-size="28" font-weight="700" fill="${C.bg}">Pay now</text>`);

for (const [name, svgText] of [["og-home-v1.png", home], ["og-default-v1.png", fallback]]) {
  const png = new Resvg(svgText, { font: { loadSystemFonts: true, defaultFontFamily: "Arial" }, fitTo: { mode: "width", value: 1200 } })
    .render()
    .asPng();
  writeFileSync(join(out, name), png);
  console.log(`wrote public/assets/og/${name} (${png.length} bytes)`);
}
