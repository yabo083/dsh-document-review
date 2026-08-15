#!/usr/bin/env node
/**
 * Verify the publish tarball is self-contained.
 *
 * The `files` field in package.json is a hand-maintained allow-list; a new
 * compiled module (or renamed asset) that is referenced at runtime but not
 * listed ships a broken package that only breaks on a fresh install (local
 * `link:` development hides it — see the lib/config.js incident).
 *
 * This script parses every relative `import ... from "./x"` inside the
 * compiled lib/*.js entry points, expands the `files` allow-list against the
 * real tree, and fails when a referenced file is not covered. Run
 * automatically before publish via `prepublishOnly`. No subprocesses: the
 * allow-list expansion is pure Node, so it works identically everywhere.
 *
 * Exit codes: 0 = package self-contained; 1 = referenced file missing.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const libDir = resolve(root, "lib");

/** Collect `from "./x"` / `from "./x.js"` / `from "../y"` targets in one file. */
function relativeImports(source) {
  const targets = [];
  // ESM: import { ... } from "./x.js"  |  export * from "./x.js"
  const importRe = /\b(?:import|export)\b[\s\S]*?from\s*["'](\.[^"']+)["']/g;
  let match;
  while ((match = importRe.exec(source)) !== null) targets.push(match[1]);
  // CJS remnants: require("./x")  |  require("./x.js")
  const requireRe = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
  while ((match = requireRe.exec(source)) !== null) targets.push(match[1]);
  return targets;
}

/**
 * Expand one `files` entry against the tree. The pattern is converted to a
 * regex (`**` crosses directory boundaries, `*` stays within one segment)
 * and matched against every file under the pattern's base directory. `!`
 * exclusions are NOT supported by this package's files list; add them by
 * filtering after the fact if ever needed.
 */
async function expandPattern(pattern, base) {
  const hits = new Set();
  const posix = (p) => p.split("\\").join("/");
  const posixPattern = pattern.split("\\").join("/");

  // Base directory = everything before the first glob metacharacter, else ".".
  const firstGlob = posixPattern.search(/[*?\[\]]/);
  const baseRel = firstGlob === -1 ? dirname(posixPattern) : posixPattern.slice(0, firstGlob).replace(/\/$/, "");
  const baseDir = resolve(base, baseRel === "." ? "" : baseRel);

  // Regex: `**/` swallows any depth, `**` matches any chars incl. separators,
  // `*` matches one segment, everything else literal.
  let re = "";
  for (let i = 0; i < posixPattern.length; i++) {
    if (posixPattern.startsWith("**/", i)) { re += "(?:.*/)?"; i += 2; }
    else if (posixPattern.startsWith("**", i)) { re += ".*"; i += 1; }
    else if (posixPattern[i] === "*") { re += "[^/]*"; }
    else if (posixPattern[i] === "?") { re += "[^/]"; }
    else re += posixPattern[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const matcher = new RegExp(`^${re}$`);

  const walk = async (dir) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const rel = posix(relative(base, full));
      if (matcher.test(rel)) hits.add(posix(join(base, rel)));
    }
  };
  await walk(baseDir);
  return hits;
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const filesField = manifest.files ?? [];
  if (!Array.isArray(filesField) || filesField.length === 0) {
    console.error("verify-pack: package.json has no `files` allow-list; add one.");
    process.exit(1);
  }

  // 1. Walk lib/*.js entry points for relative runtime imports.
  const entries = (await readdir(libDir)).filter((name) => name.endsWith(".js") && !name.endsWith(".map"));
  const referenced = new Map(); // resolved abs path -> import site
  for (const entry of entries) {
    const source = await readFile(resolve(libDir, entry), "utf8");
    for (const target of relativeImports(source)) {
      const resolved = resolve(libDir, target);
      referenced.set(resolved, `${entry} → ${target}`);
    }
  }

  // 2. Expand the files allow-list into the packed path set (npm names the
  //    tarball root "package", but coverage is what matters here).
  const packedAbs = new Set();
  for (const pattern of filesField) {
    for (const rel of await expandPattern(pattern, root)) {
      packedAbs.add(resolve(root, rel));
    }
  }
  // npm always includes package.json, README, LICENSE.
  for (const always of ["package.json", "README.md", "LICENSE"]) {
    try { packedAbs.add(resolve(root, always)); } catch { /* ignore */ }
  }

  // 3. Every referenced file must be covered.
  const missing = [];
  for (const [abs, site] of referenced) {
    if (!packedAbs.has(abs)) missing.push(`${site} (${abs.replace(root, ".")})`);
  }
  // 4. Sanity-check lib/public assets referenced by the HTML.
  const html = await readFile(resolve(libDir, "public", "index.html"), "utf8");
  const assetRe = /(?:src|href)="(\/(?:app\.js|styles\.css))"/g;
  let match;
  while ((match = assetRe.exec(html)) !== null) {
    const asset = resolve(libDir, "public", match[1].slice(1));
    if (!packedAbs.has(asset)) missing.push(`index.html → ${match[1]}`);
  }

  if (missing.length > 0) {
    console.error("verify-pack: BROKEN PACKAGE — these runtime-referenced files are not in the tarball:");
    for (const item of missing) console.error(`  ✗ ${item}`);
    console.error("\nAdd the missing paths to `files` in package.json (or widen the glob), then rebuild.");
    process.exit(1);
  }
  console.log(`verify-pack: OK — ${entries.length} lib entries, ${referenced.size} relative imports, all covered by files (${packedAbs.size} packed paths).`);
}

main().catch((error) => {
  console.error("verify-pack: failed:", error.message);
  process.exit(1);
});
