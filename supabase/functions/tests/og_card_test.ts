// Acceptance 16 (image side): per-link card layout logic. Real shaping/rasterizing needs the
// network (pinned wasm + fonts) and is exercised by `npm run og:preview`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { drawText, fitName, linkCardSvg, type TextShaper, textRuns } from "../og-image/card.ts";

// Fake shaper: 0.5 em per UTF-16 unit; records which font each run used.
function fakeShaper() {
  const calls: { font: string; text: string }[] = [];
  const shaper: TextShaper = {
    shape(font, text, size, x, y) {
      calls.push({ font, text });
      return { svg: `<path data-font="${font}" transform="translate(${x} ${y})" d="M0 0"/>`, width: text.length * size * 0.5 };
    },
  };
  return { shaper, calls };
}

Deno.test("text is split into Bengali and non-Bengali runs", () => {
  assertEquals(textRuns("রহিমের স্টুডিও & Co"), [
    { text: "রহিমের", bengali: true },
    { text: " ", bengali: false },
    { text: "স্টুডিও", bengali: true },
    { text: " & Co", bengali: false },
  ]);
  assertEquals(textRuns("Plain"), [{ text: "Plain", bengali: false }]);
});

Deno.test("runs use the Bengali or Latin font at the requested weight", () => {
  const { shaper, calls } = fakeShaper();
  drawText(shaper, "Pay রহিম", { size: 40, x: 0, y: 0, fill: "#fff", bold: true });
  assertEquals(calls.map((c) => c.font), ["sans-700", "bn-700"]);
});

Deno.test("long names shrink, then truncate to fit the 1040 px line", () => {
  const { shaper } = fakeShaper();
  assertEquals(fitName(shaper, "Short name", (s) => s, "#fff").size, 88);
  const long = fitName(shaper, "x".repeat(60), (s) => s, "#fff");
  assertEquals(long.size, 52);
  assert(long.width <= 1040);
});

Deno.test("no user-provided text ends up in the SVG as text or markup", () => {
  const { shaper } = fakeShaper();
  const svg = linkCardSvg(shaper, '<script>alert(1)</script> & "Co"', "<b>note</b>\u0007", "Boltpage");
  assert(!svg.includes("<script"));
  assert(!svg.includes("alert(1)"));
  assert(!svg.includes("<b>"));
  assert(!svg.includes("\u0007"));
  assert(svg.startsWith("<svg"));
});
