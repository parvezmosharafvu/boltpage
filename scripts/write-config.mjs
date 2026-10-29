// Writes public/config.js from environment variables at deploy time.
// Only PUBLIC values may go here. Refuses to write a service-role key.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const brand = process.env.BRAND_NAME || "Boltpage";

if (!url || !anonKey) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  process.exit(1);
}
if (!/^https:\/\/[a-z0-9.-]+$/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) {
  console.error("SUPABASE_URL must be an https origin without a path");
  process.exit(1);
}

function jwtRole(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).role ?? null;
  } catch {
    return null;
  }
}
if (anonKey.startsWith("sb_secret_") || jwtRole(anonKey) === "service_role") {
  console.error("Refusing to write a secret/service-role key into public/config.js");
  process.exit(1);
}

const config = { SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey, BRAND_NAME: brand };
const file = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "config.js");
writeFileSync(file, `window.APP_CONFIG = ${JSON.stringify(config, null, 2)};\n`);
console.log("wrote public/config.js");
