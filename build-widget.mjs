/**
 * Builds the two widget artefacts into public/:
 *   widget.js         the loader the client pastes into Webflow
 *   widget/index.html the iframe document, its Preact bundle and its CSS
 *
 * Preact rather than React: this bundle is downloaded by every visitor on
 * every page, most of them on a phone.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, statSync } from "node:fs";

mkdirSync("public/widget", { recursive: true });

const common = { bundle: true, minify: true, target: ["es2020"], legalComments: "none" };

await build({ ...common, entryPoints: ["src/widget/loader.ts"], outfile: "public/widget.js", format: "iife" });
await build({
  ...common,
  entryPoints: ["src/widget/app.tsx"],
  outfile: "public/widget/app.js",
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "preact",
  define: { __API_URL__: JSON.stringify(process.env.WIDGET_API_URL ?? "/api/chat") },
});

cpSync("src/widget/index.html", "public/widget/index.html");
cpSync("src/widget/styles.css", "public/widget/styles.css");

for (const f of ["public/widget.js", "public/widget/app.js", "public/widget/styles.css"]) {
  console.log(`${f.padEnd(28)} ${(statSync(f).size / 1024).toFixed(1)} KB`);
}
