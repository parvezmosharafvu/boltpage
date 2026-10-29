// 1200x630 per-link preview card in the site's own brand (amber on near-black).
// Rendered by satori: text is drawn as glyphs, so user-provided names cannot inject markup.
import * as React from "https://esm.sh/react@18.2.0";

const h = React.createElement;

export const BRAND_COLORS = {
  bg: "#0B0B0C",
  panel: "#17171B",
  accent: "#FFB800",
  text: "#F5F5F2",
  muted: "#A3A3AB",
};

export function truncate(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("");
}

function boltMark(size: number) {
  return h(
    "svg",
    { width: size, height: size, viewBox: "0 0 64 64" },
    h("rect", { width: 64, height: 64, rx: 16, fill: BRAND_COLORS.accent }),
    h("path", { d: "M36 8 L16 36 H30 L26 56 L48 26 H34 Z", fill: BRAND_COLORS.bg }),
  );
}

export function linkCard(displayName: string, note: string | null, brand: string) {
  const c = BRAND_COLORS;
  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: c.bg,
        padding: "72px 80px",
        color: c.text,
      },
    },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 20 } },
      boltMark(64),
      h("div", { style: { fontSize: 40, fontWeight: 700, color: c.accent } }, brand),
    ),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 12 } },
      h("div", { style: { fontSize: 36, color: c.muted } }, "Pay"),
      h("div", { style: { fontSize: 88, fontWeight: 800, lineHeight: 1.05 } }, truncate(displayName, 36)),
      note ? h("div", { style: { fontSize: 32, color: c.muted, marginTop: 8 } }, truncate(note, 100)) : null,
    ),
    h(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 28, color: c.muted } },
      h("div", { style: { display: "flex" } }, "Instant Lightning payment"),
      h(
        "div",
        {
          style: {
            display: "flex",
            padding: "14px 32px",
            borderRadius: 999,
            background: c.accent,
            color: c.bg,
            fontWeight: 700,
          },
        },
        "Pay now",
      ),
    ),
  );
}
