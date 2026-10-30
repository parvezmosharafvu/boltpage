// Minimal HarfBuzz binding over the harfbuzzjs 0.3.6 wasm (MIT). That build has no imports,
// so it instantiates in any runtime. HarfBuzz does full OpenType shaping (Bangla conjuncts,
// pre-base vowel signs, reph...), which neither satori nor resvg's own text layout gets right.
// Memory views are re-created on every access because wasm memory grows while fonts load.

export const HB_WASM_URL = "https://cdn.jsdelivr.net/npm/harfbuzzjs@0.3.6/hb.wasm";

interface HbExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  free_ptr(): number;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_get_upem(face: number): number;
  hb_font_create(face: number): number;
  hb_buffer_create(): number;
  hb_buffer_destroy(buffer: number): void;
  hb_buffer_add_utf16(buffer: number, text: number, length: number, offset: number, itemLength: number): void;
  hb_buffer_guess_segment_properties(buffer: number): void;
  hb_shape(font: number, buffer: number, features: number, numFeatures: number): void;
  hb_buffer_get_length(buffer: number): number;
  hb_buffer_get_glyph_infos(buffer: number, length: number): number;
  hb_buffer_get_glyph_positions(buffer: number, length: number): number;
  hbjs_glyph_svg(font: number, glyph: number, out: number, outSize: number): number;
}

export interface ShapedText {
  svg: string; // <path> elements, already positioned
  width: number; // advance width in px
}

const PATH_BUFFER_SIZE = 65_536;
const HB_MEMORY_MODE_WRITABLE = 2;
const round = (n: number, digits = 2) => Number(n.toFixed(digits));

export class Shaper {
  readonly #x: HbExports;
  readonly #pathBuffer: number;
  readonly #fonts = new Map<string, { font: number; upem: number }>();
  readonly #decoder = new TextDecoder();

  static async create(wasm: BufferSource): Promise<Shaper> {
    const { instance } = await WebAssembly.instantiate(wasm);
    return new Shaper(instance.exports as unknown as HbExports);
  }

  private constructor(exports: HbExports) {
    this.#x = exports;
    this.#pathBuffer = exports.malloc(PATH_BUFFER_SIZE);
  }

  addFont(name: string, bytes: Uint8Array): void {
    const x = this.#x;
    const ptr = x.malloc(bytes.byteLength);
    new Uint8Array(x.memory.buffer).set(bytes, ptr);
    const blob = x.hb_blob_create(ptr, bytes.byteLength, HB_MEMORY_MODE_WRITABLE, ptr, x.free_ptr());
    const face = x.hb_face_create(blob, 0);
    this.#fonts.set(name, { font: x.hb_font_create(face), upem: x.hb_face_get_upem(face) });
  }

  // Shapes one run of text with one font at (x0, baseline y0).
  shape(fontName: string, text: string, size: number, x0: number, y0: number): ShapedText {
    const f = this.#fonts.get(fontName);
    if (!f) throw new Error(`font ${fontName} is not loaded`);
    const x = this.#x;

    const buffer = x.hb_buffer_create();
    const textPtr = x.malloc(text.length * 2 + 2);
    const units = new Uint16Array(x.memory.buffer, textPtr, text.length);
    for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
    x.hb_buffer_add_utf16(buffer, textPtr, text.length, 0, text.length);
    x.free(textPtr);
    x.hb_buffer_guess_segment_properties(buffer);
    x.hb_shape(f.font, buffer, 0, 0);

    const n = x.hb_buffer_get_length(buffer);
    // Copy out before calling back into wasm.
    const infos = Array.from(new Uint32Array(x.memory.buffer, x.hb_buffer_get_glyph_infos(buffer, 0), n * 5));
    const positions = Array.from(new Int32Array(x.memory.buffer, x.hb_buffer_get_glyph_positions(buffer, 0), n * 5));
    x.hb_buffer_destroy(buffer);

    const scale = size / f.upem;
    let pen = 0;
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const glyph = infos[i * 5];
      const [advance, , offsetX, offsetY] = positions.slice(i * 5, i * 5 + 4);
      const length = x.hbjs_glyph_svg(f.font, glyph, this.#pathBuffer, PATH_BUFFER_SIZE);
      if (length > 0) {
        const d = this.#decoder.decode(new Uint8Array(x.memory.buffer, this.#pathBuffer, length));
        parts.push(
          `<path transform="translate(${round(x0 + (pen + offsetX) * scale)} ${round(y0 - offsetY * scale)}) scale(${round(scale, 5)} ${round(-scale, 5)})" d="${d}"/>`,
        );
      }
      pen += advance;
    }
    return { svg: parts.join(""), width: pen * scale };
  }
}
