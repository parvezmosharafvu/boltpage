// Applies ci/supabase_shim.sql + every migration to an EMPTY database, runs ci/sql/*.sql,
// then checks which functions/tables anon and authenticated can reach against
// ci/function_allowlist.txt.
//
//   DATABASE_URL=postgres://... node ci/run-sql-tests.mjs   (CI: real Postgres)
//   node ci/run-sql-tests.mjs                               (local: in-memory PGlite)
//   node ci/run-sql-tests.mjs --update-allowlist            (rewrite the allowlist after review)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const updateAllowlist = process.argv.includes("--update-allowlist");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const sqlFiles = (dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith(".sql")).sort();

async function connect() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    return {
      name: "postgres",
      exec: (sql) => client.query(sql),
      rows: async (sql) => (await client.query(sql)).rows,
      close: () => client.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  return {
    name: "pglite",
    exec: (sql) => db.exec(sql),
    rows: async (sql) => (await db.query(sql)).rows,
    close: () => db.close(),
  };
}

const db = await connect();
let failures = 0;

async function step(label, sql) {
  try {
    await db.exec(sql);
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${label}\n       ${err.message}`);
    try {
      await db.exec("rollback");
    } catch {
      // not in a transaction
    }
  }
}

console.log(`database: ${db.name}`);
console.log("migrations:");
await step("ci/supabase_shim.sql", read("ci", "supabase_shim.sql"));
for (const file of sqlFiles("supabase/migrations")) {
  await step(`supabase/migrations/${file}`, read("supabase", "migrations", file));
}
if (failures) {
  console.log(`\n${failures} migration(s) failed`);
  await db.close();
  process.exit(1);
}

console.log("sql tests:");
for (const file of sqlFiles("ci/sql")) {
  await step(`ci/sql/${file}`, read("ci", "sql", file));
}

console.log("privileges:");
const actual = (
  await db.rows(`
    select r.rolname || ' ' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as entry
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated')) r (rolname)
    where n.nspname = 'public' and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    order by 1`)
).map((r) => r.entry);

const allowlistPath = join(root, "ci", "function_allowlist.txt");
if (updateAllowlist) {
  writeFileSync(allowlistPath, `# role function(argtypes) — reviewed list of RPCs reachable without the service role\n${actual.join("\n")}\n`);
  console.log(`  wrote ci/function_allowlist.txt (${actual.length} entries)`);
} else {
  const expected = readFileSync(allowlistPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const extra = actual.filter((e) => !expected.includes(e));
  const missing = expected.filter((e) => !actual.includes(e));
  if (extra.length || missing.length) {
    failures++;
    console.log("  FAIL function allowlist");
    for (const e of extra) console.log(`       + ${e}   (executable but not allowlisted)`);
    for (const e of missing) console.log(`       - ${e}   (allowlisted but not executable)`);
  } else {
    console.log(`  ok   function allowlist (${actual.length} entries)`);
  }
}

const anonTables = await db.rows(`
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
    and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')
      or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE'))`);
if (anonTables.length) {
  failures++;
  console.log(`  FAIL anon can touch tables: ${anonTables.map((r) => r.relname).join(", ")}`);
} else {
  console.log("  ok   anon has no table privileges");
}

const authWrites = await db.rows(`
  select c.relname, p.priv from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p (priv)
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
    and has_table_privilege('authenticated', c.oid, p.priv)
    and not (c.relname = 'profiles' and p.priv = 'UPDATE')`);
if (authWrites.length) {
  failures++;
  console.log(`  FAIL authenticated can write: ${authWrites.map((r) => `${r.relname}:${r.priv}`).join(", ")}`);
} else {
  console.log("  ok   authenticated writes only via RPCs (plus guarded profiles UPDATE)");
}

await db.close();
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall SQL checks passed");
