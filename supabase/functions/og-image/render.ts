// Link card -> PNG. HarfBuzz (wasm) shapes the text into paths; resvg (wasm) rasterizes.
// Both wasm modules and the fonts are fetched once per isolate from pinned URLs; a failed
// load is retried on the next request.
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import { FONT_FILES, linkCardSvg, RESVG_WASM_URL } from "./card.ts";
import { HB_WASM_URL, Shaper } from "./shaper.ts";

let resvgReady: Promise<void> | null = null;
let shaperReady: Promise<Shaper> | null = null;

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function once<T>(get: () => Promise<T> | null, set: (p: Promise<T> | null) => void, load: () => Promise<T>): Promise<T> {
  let p = get();
  if (!p) {
    p = load();
    set(p);
    p.catch(() => set(null));
  }
  return p;
}

const loadResvg = () => once(() => resvgReady, (p) => (resvgReady = p), () => initWasm(fetch(RESVG_WASM_URL)));

const loadShaper = () =>
  once(() => shaperReady, (p) => (shaperReady = p), async () => {
    const [wasm, ...fonts] = await Promise.all([fetchBytes(HB_WASM_URL), ...FONT_FILES.map(([, url]) => fetchBytes(url))]);
    const shaper = await Shaper.create(wasm);
    FONT_FILES.forEach(([name], i) => shaper.addFont(name, fonts[i]));
    return shaper;
  });

export async function renderLinkCard(displayName: string, note: string | null, brand: string): Promise<Uint8Array<ArrayBuffer>> {
  const [shaper] = await Promise.all([loadShaper(), loadResvg()]);
  const svg = linkCardSvg(shaper, displayName, note, brand);
  const png = new Resvg(svg, { font: { loadSystemFonts: false }, fitTo: { mode: "width", value: 1200 } }).render().asPng();
  return new Uint8Array(png);
}
