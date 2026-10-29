import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidSlug, RESERVED_SLUGS, slugFromPath } from "../../public/slug-rules.js";
import { BN_STRINGS, EN_STRINGS } from "../../public/i18n.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

test("reserved slugs match public.reserved_slugs in the migration", () => {
  const sql = read("supabase", "migrations", "0003_links_profiles.sql");
  const block = /insert into public\.reserved_slugs \(slug\) values([\s\S]*?);/.exec(sql)[1];
  const fromSql = [...block.matchAll(/\('([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...RESERVED_SLUGS].sort(), fromSql);
});

test("slug paths", () => {
  assert.equal(slugFromPath("/alice"), "alice");
  assert.equal(slugFromPath("/pay/alice/"), "alice");
  assert.equal(slugFromPath("/Alice-Shop"), "alice-shop");
  assert.equal(slugFromPath("/dashboard"), null);
  assert.equal(slugFromPath("/assets/og/x.png"), null);
  assert.equal(slugFromPath("/styles.css"), null);
  assert.equal(slugFromPath("/a--b"), null);
  assert.equal(slugFromPath("/%E0%A4"), null);
  assert.equal(isValidSlug("ab"), false);
});

test("every English string has a Bangla translation (admin panel excepted)", () => {
  const missing = Object.keys(EN_STRINGS).filter((k) => !k.startsWith("adm.") && !(k in BN_STRINGS));
  assert.deepEqual(missing, []);
  const extra = Object.keys(BN_STRINGS).filter((k) => !(k in EN_STRINGS));
  assert.deepEqual(extra, []);
});

test("placeholders match between languages", () => {
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const [k, v] of Object.entries(BN_STRINGS)) assert.equal(vars(v), vars(EN_STRINGS[k]), k);
});

test("every i18n key used in HTML and JS exists", () => {
  const pub = join(ROOT, "public");
  const used = new Set();
  for (const f of readdirSync(pub)) {
    const text = f.endsWith(".html") || f.endsWith(".js") ? read("public", f) : "";
    for (const m of text.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/\bt\("([a-z][\w.]+)"/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !(k in EN_STRINGS));
  assert.deepEqual(missing, []);
});
