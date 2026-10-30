// 1200x630 per-link preview card in the site's own brand (amber on near-black).
// All text is shaped by HarfBuzz (shaper.ts) and drawn as glyph paths, so Bangla renders
// correctly and no user-provided string ever appears in the SVG as text or markup.
import type { ShapedText } from "./shaper.ts";

export const BRAND_COLORS = {
  bg: "#0B0B0C",
  accent: "#FFB800",
  text: "#F5F5F2",
  muted: "#A3A3AB",
};

// Pinned font files (SIL Open Font License) and the resvg wasm build.
export const FONT_FILES: [name: string, url: string][] = [
  ["sans-400", "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans@0.4.2/400Regular/NotoSans_400Regular.ttf"],
  ["sans-700", "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans@0.4.2/700Bold/NotoSans_700Bold.ttf"],
  ["bn-400", "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-bengali@0.4.4/400Regular/NotoSansBengali_400Regular.ttf"],
  ["bn-700", "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-bengali@0.4.4/700Bold/NotoSansBengali_700Bold.ttf"],
];
export const RESVG_WASM_URL = "https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm";

export interface TextShaper {
  shape(fontName: string, text: string, size: number, x: number, y: number): ShapedText;
}

const CONTENT_WIDTH = 1040;
const BENGALI_RUN = /[ঀ-৿‌‍।॥]+|[^ঀ-৿‌‍।॥]+/g;

export function truncate(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("");
}

// Splits text into runs that each go to one font (Bengali vs everything else).
export function textRuns(text: string): { text: string; bengali: boolean }[] {
  return (text.match(BENGALI_RUN) ?? []).map((t) => ({ text: t, bengali: /[ঀ-৿]/.test(t) }));
}

interface DrawOptions {
  size: number;
  x: number;
  y: number;
  fill: string;
  bold?: boolean;
  anchor?: "start" | "middle";
}

export function drawText(shaper: TextShaper, text: string, o: DrawOptions): ShapedText {
  const runs = textRuns(text.replace(/[\u0000-\u001F\u007F]/g, ""));
  const weight = o.bold ? "700" : "400";
  const layout = (startX: number) => {
    let x = startX;
    const parts: string[] = [];
    for (const run of runs) {
      const shaped = shaper.shape(`${run.bengali ? "bn" : "sans"}-${weight}`, run.text, o.size, x, o.y);
      parts.push(shaped.svg);
      x += shaped.width;
    }
    return { svg: parts.join(""), width: x - startX };
  };
  let out = layout(o.x);
  if (o.anchor === "middle") out = layout(o.x - out.width / 2);
  return { svg: `<g fill="${o.fill}">${out.svg}</g>`, width: out.width };
}

// Largest size (88 -> 52 px) at which the name fits on one line; below that, truncate.
export function fitName(shaper: TextShaper, name: string, y: (size: number) => number, fill: string): ShapedText & { size: number } {
  let text = truncate(name, 60);
  for (const size of [88, 76, 64, 52]) {
    const shaped = drawText(shaper, text, { size, x: 80, y: y(size), fill, bold: true });
    if (shaped.width <= CONTENT_WIDTH) return { ...shaped, size };
  }
  const chars = Array.from(text);
  while (chars.length > 1) {
    chars.pop();
    text = chars.join("").trimEnd() + "…";
    const shaped = drawText(shaper, text, { size: 52, x: 80, y: y(52), fill, bold: true });
    if (shaped.width <= CONTENT_WIDTH) return { ...shaped, size: 52 };
  }
  return { ...drawText(shaper, "…", { size: 52, x: 80, y: y(52), fill, bold: true }), size: 52 };
}

function fitLine(shaper: TextShaper, text: string, o: DrawOptions): ShapedText {
  const chars = Array.from(truncate(text, 120));
  let candidate = chars.join("");
  for (;;) {
    const shaped = drawText(shaper, candidate, o);
    if (shaped.width <= CONTENT_WIDTH || chars.length <= 1) return shaped;
    chars.pop();
    candidate = chars.join("").trimEnd() + "…";
  }
}

export function linkCardSvg(shaper: TextShaper, displayName: string, note: string | null, brand: string): string {
  const c = BRAND_COLORS;
  const nameTop = 268 + 24;
  const name = fitName(shaper, displayName, (size) => nameTop + size, c.text);
  const parts = [
    drawText(shaper, truncate(brand, 30), { size: 40, x: 164, y: 118, fill: c.accent, bold: true }).svg,
    drawText(shaper, "Pay", { size: 36, x: 80, y: 268, fill: c.muted }).svg,
    name.svg,
    note ? fitLine(shaper, note, { size: 32, x: 80, y: nameTop + name.size + 62, fill: c.muted }).svg : "",
    drawText(shaper, "Instant Lightning payment", { size: 28, x: 80, y: 545, fill: c.muted }).svg,
    drawText(shaper, "Pay now", { size: 28, x: 1010, y: 545, fill: c.bg, bold: true, anchor: "middle" }).svg,
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="0.82" cy="0.18" r="0.7">
      <stop offset="0" stop-color="${c.accent}" stop-opacity="0.2"/>
      <stop offset="1" stop-color="${c.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="${c.bg}"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <g transform="translate(80 72)">
    <rect width="64" height="64" rx="16" fill="${c.accent}"/>
    <path d="M36 8 L16 36 H30 L26 56 L48 26 H34 Z" fill="${c.bg}"/>
  </g>
  <rect x="900" y="500" width="220" height="68" rx="34" fill="${c.accent}"/>
  ${parts.join("\n  ")}
</svg>`;
}
