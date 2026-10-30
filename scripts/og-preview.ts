// Renders sample per-link OG cards with exactly the code the og-image function uses, so the
// design and non-Latin names can be checked without deploying:
//   npm run og:preview            (writes test-results/og/*.png)
import { renderLinkCard } from "../supabase/functions/og-image/render.ts";

const out = Deno.args[0] ?? "test-results/og";
await Deno.mkdir(out, { recursive: true });

const samples: [string, string, string | null][] = [
  ["latin", "Rahim's Studio", "Thanks for your order! Pay any amount between $10 and $1,000."],
  ["bangla", "রহিমের স্টুডিও", "অর্ডারের জন্য ধন্যবাদ! Pay with any wallet."],
  ["long", "A very long display name that keeps going and going and going", null],
  ["markup", "<script>alert(1)</script> & \"Co\"", "Note with <b>tags</b>\u0007 and a bell"],
];

for (const [name, displayName, note] of samples) {
  const bytes = await renderLinkCard(displayName, note, "Boltpage");
  await Deno.writeFile(`${out}/${name}.png`, bytes);
  console.log(`${out}/${name}.png  ${bytes.length} bytes`);
}
