// Copy the review page static assets into lib/public so the compiled review.js
// can resolve them relative to its own location (lib/public/).
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "lib", "public"), { recursive: true });
await cp(resolve(root, "public"), resolve(root, "lib", "public"), { recursive: true });
console.error("[copy-assets] public/ → lib/public/");
