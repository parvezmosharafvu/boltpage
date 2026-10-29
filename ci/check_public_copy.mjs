// Public-copy and public-secret checks. Fails the build when public surfaces
// (public/, the preview Worker, the OG image renderer):
//   - name payout rails (they may appear only inside the logged-in dashboard, via admin settings),
//   - mention "Cash App" anywhere except the factual deeplink button label,
//   - use Cash App green in CSS/SVG/JS or in PNG pixels,
//   - contain anything that looks like a secret (service-role JWT, macaroon, bot token...).
//
//   node ci/check_public_copy.mjs                 all checks
//   node ci/check_public_copy.mjs --secrets-only  secrets only (used by the secrets CI job)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

export const FORBIDDEN = [
  /\bb-?kash\b/i,
  /\bnagad\b/i,
  /\bbinance(\s*pay)?\b/i,
  /\bbank\s+transfers?\b/i,
  /\bbreez\b/i,
  /\bspark\b/i,
  /বিকাশ/,
  /নগদ/,
  /বাইন্যান্স/,
  /ব্যাংক\s*ট্রান্সফার/,
];

// The only allowed mentions: the deeplink button label in English and Bangla.
export const ALLOWED_LABELS = ["Open in Cash App", "Cash App-এ খুলুন"];
const CASH_APP_RE = /cash\s*app/i;
const GREEN_TEXT_RE = /#?00d632\b|#?00d54b\b|rgba?\(\s*0\s*,\s*21[34]\s*,\s*(50|75)\b/i;

export const SECRET_PATTERNS = [
  { name: "Supabase secret key", re: /\bsb_secret_[0-9A-Za-z_-]{10,}/ },
  { name: "LND macaroon (hex)", re: /0201036c6e64[0-9a-f]{20,}/i },
  { name: "Telegram bot token", re: /\b\d{8,10}:AA[0-9A-Za-z_-]{30,}\b/ },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "service role assignment", re: /SERVICE_ROLE_KEY\s*[=:]\s*["']?eyJ/ },
];

const JWT_RE = /eyJ[0-9A-Za-z_-]{8,}\.(eyJ[0-9A-Za-z_-]{8,})\.[0-9A-Za-z_-]{8,}/g;

const TEXT_EXT = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".txt", ".md", ".ts", ".tsx", ""]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function scanCopy(name, text) {
  const problems = [];
  for (const re of FORBIDDEN) {
    const m = re.exec(text);
    if (m) problems.push(`${name}: forbidden public word "${m[0]}"`);
  }
  let stripped = text;
  for (const label of ALLOWED_LABELS) stripped = stripped.split(label).join("");
  const cash = CASH_APP_RE.exec(stripped);
  if (cash) {
    const at = stripped.slice(Math.max(0, cash.index - 30), cash.index + 30).replace(/\s+/g, " ");
    problems.push(`${name}: "Cash App" outside the button label: …${at}…`);
  }
  const green = GREEN_TEXT_RE.exec(text);
  if (green) problems.push(`${name}: Cash App green "${green[0]}"`);
  return problems;
}

export function scanSecrets(name, text) {
  const problems = [];
  for (const { name: kind, re } of SECRET_PATTERNS) if (re.test(text)) problems.push(`${name}: looks like a ${kind}`);
  for (const m of text.matchAll(JWT_RE)) {
    try {
      const payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
      if (payload.role === "service_role") problems.push(`${name}: service_role JWT`);
    } catch {
      // not a JWT
    }
  }
  return problems;
}

// Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) to look for Cash App green pixels.
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0) return null;
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, bpp, px };
}

const GREENS = [[0x00, 0xd6, 0x32], [0x00, 0xd5, 0x4b]];
export function greenShare(img) {
  let hits = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * img.bpp;
    const [r, g, b] = [img.px[o], img.px[o + 1], img.px[o + 2]];
    if (GREENS.some(([R, G, B]) => Math.abs(r - R) + Math.abs(g - G) + Math.abs(b - B) < 40)) hits++;
  }
  return hits / n;
}

function main() {
  const secretsOnly = process.argv.includes("--secrets-only");
  const copyFiles = [
    ...walk(join(ROOT, "public")).filter((f) => !f.includes(`${join("public", "vendor")}`)),
    join(ROOT, "worker", "og-preview-worker.js"),
    ...walk(join(ROOT, "supabase", "functions", "og-image")),
  ];
  const secretFiles = [...walk(join(ROOT, "public")), join(ROOT, "worker", "og-preview-worker.js"), join(ROOT, "worker", "wrangler.jsonc"), join(ROOT, "wrangler.jsonc")];
  const problems = [];

  if (!secretsOnly) {
    for (const file of copyFiles) {
      const name = relative(ROOT, file);
      const ext = extname(file).toLowerCase();
      if (TEXT_EXT.has(ext)) problems.push(...scanCopy(name, readFileSync(file, "utf8")));
      else if (ext === ".png") {
        const img = decodePng(readFileSync(file));
        if (img && greenShare(img) > 0.002) problems.push(`${name}: contains Cash App green pixels`);
      }
    }
  }
  for (const file of secretFiles) {
    if (!TEXT_EXT.has(extname(file).toLowerCase()) && extname(file) !== ".jsonc") continue;
    problems.push(...scanSecrets(relative(ROOT, file), readFileSync(file, "utf8")));
  }

  if (problems.length) {
    console.error(`public check failed (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`public check passed (${secretsOnly ? "secrets" : "copy, colours and secrets"}; ${new Set([...copyFiles, ...secretFiles]).size} files)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
