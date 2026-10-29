// Copies the two browser libraries into public/vendor so the site needs no CDN
// (keeps the CSP at script-src 'self'). Run after `npm ci` when bumping versions.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "vendor");
mkdirSync(out, { recursive: true });

const libs = [
  { pkg: "@supabase/supabase-js", from: "dist/umd/supabase.js", to: "supabase.js", license: "MIT" },
  { pkg: "qrcode-generator", from: "dist/qrcode.mjs", to: "qrcode.mjs", license: "MIT" },
];

for (const lib of libs) {
  const base = join(root, "node_modules", lib.pkg);
  const { version } = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
  const body = readFileSync(join(base, lib.from), "utf8");
  writeFileSync(join(out, lib.to), `/*! ${lib.pkg}@${version} | ${lib.license} */\n${body}`);
  console.log(`vendored ${lib.pkg}@${version} -> public/vendor/${lib.to}`);
}
