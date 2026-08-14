// @ts-nocheck
/**
 * Document review core: a local HTTP server that renders a Markdown document
 * read-only and lets the browser add annotations (comment / replace / delete)
 * stored in a central JSONL store (~/.dsh-document-review/annotations.jsonl).
 *
 * Adapted from opencode-document-review (github:yabo083/opencode-document-review)
 * for DSH. The HTTP server and security model are unchanged; annotations now
 * live in one central append-only store instead of per-document sidecars.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { access, lstat, open, readFile, readdir, realpath, rename, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, isAbsolute, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import MarkdownIt from "markdown-it";
import lockfile from "proper-lockfile";
import { DEFAULT_REVIEW_CONFIG, type ReviewConfig } from "./config.js";

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });

/** Entry-config layer (cordis.yml / settings / apply argument). Defaults keep
 * the module usable when no settings provider exists. */
let reviewConfig: ReviewConfig = DEFAULT_REVIEW_CONFIG;

/** User-persisted global overrides (review page → 全局设置). */
let globalOverrides: Partial<ReviewConfig> = {};

/** User-persisted per-workspace overrides keyed by the review root path. */
let workspaceOverrides: Record<string, Partial<ReviewConfig>> = {};

const configGlobalFile = resolve(homedir(), ".dsh-document-review", "config.json");
const configWorkspacesFile = resolve(homedir(), ".dsh-document-review", "workspace-configs.json");

/** Load persisted global + per-workspace settings (best effort; missing files
 * are normal on first run). */
export async function loadPersistedConfigs(): Promise<void> {
  try {
    const raw = await readFile(configGlobalFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<ReviewConfig>;
    if (parsed && typeof parsed === "object") globalOverrides = sanitizeConfig(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[dsh-document-review] read ${configGlobalFile}: ${(error as Error).message}`);
  }
  try {
    const raw = await readFile(configWorkspacesFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, Partial<ReviewConfig>>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      workspaceOverrides = {};
      for (const [path, section] of Object.entries(parsed)) {
        if (section && typeof section === "object") workspaceOverrides[path] = sanitizeConfig(section);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[dsh-document-review] read ${configWorkspacesFile}: ${(error as Error).message}`);
  }
}

/** Keep arbitrary JSON from a user-edited file within the known shape. */
function sanitizeConfig(value: Record<string, unknown>): Partial<ReviewConfig> {
  const clean: Partial<ReviewConfig> = {};
  const source = value as Record<string, unknown>;
  const numbers: Array<keyof ReviewConfig> = [
    "preferredPort", "maxPortTries", "idleTimeoutMinutes", "indexMaxRoots",
    "indexMaxEntries", "indexScanCooldownMs",
  ];
  for (const key of numbers) {
    const n = Number(source[key]);
    if (Number.isFinite(n)) clean[key] = n as never;
  }
  if (typeof source.openBrowserOnStart === "boolean") clean.openBrowserOnStart = source.openBrowserOnStart;
  if (typeof source.showHiddenFiles === "boolean") clean.showHiddenFiles = source.showHiddenFiles;
  if (Array.isArray(source.indexIgnore)) {
    clean.indexIgnore = source.indexIgnore.filter((x): x is string => typeof x === "string");
  }
  return clean;
}

/** Persist a global settings update; applies immediately where live. Pass an
 * empty patch to clear every persisted global override. */
export async function saveGlobalConfig(patch: Partial<ReviewConfig>): Promise<Partial<ReviewConfig>> {
  const clean = sanitizeConfig(patch as Record<string, unknown>);
  globalOverrides = Object.keys(clean).length > 0 ? { ...globalOverrides, ...clean } : {};
  await persistConfigFile(configGlobalFile, globalOverrides);
  refreshActiveInstanceConfig();
  return globalOverrides;
}

/** Persist a per-workspace settings update (keyed by the review root path);
 * applies immediately where live. Pass an empty patch to clear this root's
 * overrides. */
export async function saveWorkspaceConfig(rootPath: string, patch: Partial<ReviewConfig>): Promise<Partial<ReviewConfig>> {
  const clean = sanitizeConfig(patch as Record<string, unknown>);
  const section = Object.keys(clean).length > 0 ? { ...(workspaceOverrides[rootPath] ?? {}), ...clean } : {};
  workspaceOverrides = { ...workspaceOverrides, [rootPath]: section };
  await persistConfigFile(configWorkspacesFile, workspaceOverrides);
  refreshActiveInstanceConfig();
  return section;
}

async function persistConfigFile(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, file);
}

/** The merged snapshot a review session for `rootPath` should use. */
export function configForRoot(rootPath: string): ReviewConfig {
  const merged = { ...DEFAULT_REVIEW_CONFIG, ...reviewConfig, ...globalOverrides };
  const section = workspaceOverrides[rootPath];
  return section ? { ...merged, ...section } : merged;
}

/** Apply a new entry-config snapshot (cordis.yml / settings / apply argument).
 * Index limits take effect on the next scan; server-side values (port, idle
 * timeout) on the next session start. */
export function applyReviewConfig(config: ReviewConfig) {
  reviewConfig = { ...DEFAULT_REVIEW_CONFIG, ...config };
}

/** The global-view snapshot (entry + persisted global overrides). */
function currentConfig(): ReviewConfig {
  return { ...DEFAULT_REVIEW_CONFIG, ...reviewConfig, ...globalOverrides };
}

/** Push live-friendly persisted values (idle timeout, ignore list) into the
 * running singleton when one exists for the affected root. */
export function refreshActiveInstanceConfig(): void {
  const instance = activeInstance;
  if (!instance) return;
  const merged = configForRoot(instance.rootPath);
  instance.idleTimeoutMs = merged.idleTimeoutMinutes * 60 * 1000;
  armIdleWatchdog(instance);
}

// Resolve the review page static assets. In the source tree this is ../public/;
// in the compiled package the assets are copied to ./public/ beside review.js.
const publicDirectory = await resolvePublicDirectory();

/**
 * The virtual "This PC" level shown above every drive root (modeled after the
 * mature directory browsers: Windows Explorer, VS Code's open dialog, and
 * DSH's own host/directory-picker-browse). Listing it returns every available
 * drive; navigating up from a drive root lands here, which is what lets the
 * review page reach files OUTSIDE the workspace (e.g. OneDrive on C: while
 * the workspace lives on E:).
 */
const THIS_PC = "::computer";

/**
 * True when the path names one fixed filesystem location regardless of
 * process state: POSIX-absolute on POSIX; on Windows only drive-qualified
 * (`C:\…`) or complete UNC (`\\server\share…`) forms. Ported from DSH's
 * host/directory-picker-browse so a relative or rooted drive-less input is
 * never silently rebased under the process cwd.
 */
function fullyQualified(path: string): boolean {
  return process.platform === "win32"
    ? isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : isAbsolute(path);
}

/**
 * Ancestor chain from the filesystem root to `target` inclusive — the
 * breadcrumb rows of a listing, every one a jump target. Ported from DSH's
 * host/directory-picker-browse (ancestryCrumbs): the root crumb is labeled by
 * its full path (`C:\`, `/`), which is what makes cross-drive navigation
 * possible from the breadcrumb bar.
 */
function ancestryCrumbs(target: string): Array<{ name: string; path: string }> {
  const crumbs: Array<{ name: string; path: string }> = [];
  let current = target;
  for (;;) {
    const parent = dirname(current);
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current });
    if (parent === current) return crumbs;
    current = parent;
  }
}

/** Enumerate every available drive on Windows (`C:\`, `D:\`, …) as directory rows. */
async function listDrives(): Promise<Array<{ name: string; path: string; kind: "dir" }>> {
  const drives: Array<{ name: string; path: string; kind: "dir" }> = [];
  if (process.platform !== "win32") {
    drives.push({ name: "/", path: "/", kind: "dir" });
    return drives;
  }
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const drive = `${letter}:\\`;
    try {
      await lstat(drive);
      drives.push({ name: drive, path: drive, kind: "dir" });
    } catch {
      // No such drive; skip.
    }
  }
  return drives;
}

async function resolvePublicDirectory(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, "public"), resolve(here, "../public")]) {
    try {
      await access(resolve(candidate, "index.html"));
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error(`Review page assets not found (looked beside and above ${here})`);
}
const writeQueues = new Map<string, Promise<unknown>>();
const activeStatuses = new Set(["open", "pending"]);
const allowedStatuses: Record<string, Set<string>> = {
  comment: new Set(["open", "resolved"]),
  replace: new Set(["pending", "accepted", "rejected"]),
  delete: new Set(["pending", "accepted", "rejected"]),
};

interface JsonResponse {
  (response: import("node:http").ServerResponse, status: number, value: unknown): void;
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function securityHeaders(response: import("node:http").ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function hashDocument(source: string) {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

/* ---------------------------------------------------------------------------
 * Central annotation store.
 *
 * All review annotations for EVERY document — inside or outside the agent's
 * working directory — live in one append-only JSONL file:
 *
 *   ~/.dsh-document-review/annotations.jsonl
 *
 * One line per annotation (including status updates, which append a new
 * record with the same id; reads dedupe by id, last one wins). The agent can
 * then answer "did the user leave notes?" with a single call — no filesystem
 * walk, no sidecar discovery. Annotations on files outside the workspace are
 * just as reachable as ones inside it.
 * ------------------------------------------------------------------------ */

const annotationStoreFile = resolve(homedir(), ".dsh-document-review", "annotations.jsonl");
/** documentPath (case-folded) -> annotationId -> annotation (latest record). */
const annotationStore = new Map<string, Map<string, Annotation>>();
let annotationStoreLoaded = false;

async function loadAnnotationStore() {
  if (annotationStoreLoaded) return;
  annotationStoreLoaded = true;
  const handle = await openVerifiedRegularFile(annotationStoreFile, "r", "Annotation store", true);
  if (!handle) return;
  try {
    const source = await handle.readFile("utf8");
    const records = source.endsWith("\n") ? source : source.slice(0, source.lastIndexOf("\n") + 1);
    for (const line of records.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const annotation = JSON.parse(line) as Annotation;
        if (typeof annotation.id !== "string" || !annotation.id || typeof annotation.document !== "string") continue;
        const key = annotation.document.toLowerCase();
        let bucket = annotationStore.get(key);
        if (!bucket) annotationStore.set(key, (bucket = new Map()));
        bucket.set(annotation.id, annotation); // later records win (status updates)
      } catch {
        // skip a corrupt line; the file is append-only and self-healing
      }
    }
  } finally {
    await handle.close();
  }
}

/** Append one record to the central store (serialized across documents). */
async function appendAnnotationRecord(annotation: Annotation) {
  const key = "@store";
  const previous = writeQueues.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const releaseLock = await acquireSidecarLock(annotationStoreFile);
    try {
      await recoverIncompleteTail(annotationStoreFile);
      await appendJsonl(annotationStoreFile, annotation);
    } finally {
      await releaseLock();
    }
  });
  writeQueues.set(key, operation as Promise<unknown>);
  try {
    await operation;
  } finally {
    if (writeQueues.get(key) === operation) writeQueues.delete(key);
  }
}

function storeAnnotationsFor(documentPath: string): Map<string, Annotation> {
  let bucket = annotationStore.get(documentPath.toLowerCase());
  if (!bucket) annotationStore.set(documentPath.toLowerCase(), (bucket = new Map()));
  return bucket;
}

function listAnnotationsFromStore(documentPath: string): Annotation[] {
  return [...(annotationStore.get(documentPath.toLowerCase()) ?? new Map()).values()];
}

/** Aggregate every annotation in the store, grouped by document path. */
export async function listAllAnnotations(): Promise<Array<{ documentPath: string; annotations: Annotation[] }>> {
  await loadAnnotationStore();
  const groups: Array<{ documentPath: string; annotations: Annotation[] }> = [];
  for (const [key, bucket] of annotationStore) {
    const annotations = [...bucket.values()];
    // Recover the real path casing from the newest record (we store the
    // case-folded key separately; annotations carry their exact path).
    const documentPath = annotations[annotations.length - 1]?.document ?? key;
    groups.push({ documentPath, annotations });
  }
  groups.sort((a, b) => a.documentPath.localeCompare(b.documentPath));
  return groups;
}

/**
 * One-time migration: import any legacy `<document>.review.jsonl` sidecars
 * into the central store, then delete the sidecar files. Runs in the
 * background on startup so the user's existing notes are not lost.
 */
async function migrateLegacySidecars(roots: Iterable<string>) {
  await loadAnnotationStore();
  const seen = new Set<string>();
  const tempDirs = new Set<string>();
  try {
    tempDirs.add(resolve(tmpdir())); // C:\Users\...\AppData\Local\Temp
  } catch {
    // ignore
  }
  const walk = async (dir: string) => {
    if (seen.has(dir) || tempDirs.has(dir)) return;
    seen.add(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await stat(full).catch(() => null);
        if (target?.isDirectory()) await walk(full); // junction: keep walking
        continue;
      }
      if (entry.isDirectory()) {
        if (indexIgnoreSet().has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".review.jsonl")) {
        const documentPath = full.slice(0, -".review.jsonl".length);
        if (![".md", ".markdown"].includes(extname(documentPath).toLowerCase())) continue;
        try {
          const legacy = await readJsonl(full);
          // Skip sidecars whose document no longer exists (e.g. temp test
          // fixtures cleaned up long ago) — importing them would litter the
          // central store with dead notes.
          const docExists = await lstatOrNull(documentPath);
          if (!docExists || !docExists.isFile()) continue;
          const bucket = storeAnnotationsFor(documentPath);
          let imported = 0;
          for (const annotation of legacy) {
            if (typeof annotation.id !== "string" || !annotation.id) continue;
            if (!bucket.has(annotation.id)) {
              bucket.set(annotation.id, annotation);
              await appendAnnotationRecord(annotation); // persist to the store
              imported += 1;
            }
          }
          if (imported > 0) {
            // eslint-disable-next-line no-console
            console.log(`[document-review] migrated ${imported} annotation(s) from ${full}`);
          }
          await unlink(full).catch(() => {});
          await unlink(`${full}.lock`).catch(() => {});
        } catch {
          // unreadable sidecar: leave it in place rather than losing data
        }
      }
    }
  };
  for (const root of roots) await walk(root);
}

function titleFromMarkdown(source: string, documentPath: string) {
  return source.match(/^#\s+(.+)$/m)?.[1]?.trim() || documentPath.split(/[\\/]/).at(-1) || documentPath;
}

interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

interface Anchor {
  textQuote: TextQuote;
}

interface Annotation {
  schema: string;
  id: string;
  document: string;
  documentHash: string;
  kind: "comment" | "replace" | "delete";
  status: "open" | "resolved" | "pending" | "accepted" | "rejected";
  anchor: Anchor;
  body: string;
  replacement: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

function normalizeAnchor(anchor: { textQuote?: { exact?: string; prefix?: string; suffix?: string } } | undefined): Anchor {
  const quote = anchor?.textQuote;
  if (!quote || typeof quote.exact !== "string" || !quote.exact.trim()) {
    throw new Error("A non-empty textQuote.exact anchor is required");
  }
  return {
    textQuote: {
      exact: quote.exact,
      prefix: typeof quote.prefix === "string" ? quote.prefix : "",
      suffix: typeof quote.suffix === "string" ? quote.suffix : "",
    },
  };
}

interface AnnotationInput {
  kind?: string;
  body?: string;
  replacement?: string;
  anchor?: { textQuote?: { exact?: string; prefix?: string; suffix?: string } };
}

function normalizeAnnotationInput(input: AnnotationInput) {
  if (!input?.kind || !allowedStatuses[input.kind]) throw new Error("kind must be comment, replace, or delete");
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const replacement = typeof input.replacement === "string" ? input.replacement : "";
  if (input.kind === "comment" && !body) throw new Error("A comment body is required");
  if (input.kind === "replace" && !replacement) throw new Error("Replacement text is required");
  return { kind: input.kind as "comment" | "replace" | "delete", anchor: normalizeAnchor(input.anchor), body, replacement };
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/* ---------------------------------------------------------------------------
 * Everything-style filename index.
 *
 * The point is speed: like Everything (which reads the NTFS MFT file-name
 * table) we index FILE NAMES ONLY — never file contents — into an in-memory
 * map keyed by lowercased name, so a search is a hash lookup + score pass,
 * not a filesystem walk. The index scope is "directories the user actually
 * browsed to", persisted so it survives restarts. Directory skipping reuses
 * the ignore patterns DSH ships in vendor/hmr (node_modules, .git, cache,
 * data, dot-entries) plus common build/archive dirs.
 * ------------------------------------------------------------------------ */

interface IndexEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

interface IndexPersist {
  roots: string[];
  scannedAt: Record<string, number>;
}

const indexStateFile = resolve(homedir(), ".dsh-document-review", "index-state.json");

function indexIgnoreSet(): Set<string> {
  return new Set(currentConfig().indexIgnore);
}

/** lowercased file name -> every indexed entry with that name. */
const indexByName = new Map<string, IndexEntry[]>();
/** path -> entry, used to keep the index free of duplicates across roots. */
const indexByPath = new Map<string, IndexEntry>();
/** root path -> last full scan timestamp (ms). */
const indexScannedAt = new Map<string, number>();
let indexRoots = new Set<string>();
let indexPersistQueued = false;

async function loadIndexState() {
  try {
    const raw = await readFile(indexStateFile, "utf8");
    const state = JSON.parse(raw) as IndexPersist;
    if (Array.isArray(state.roots)) indexRoots = new Set(state.roots);
    // scannedAt is intentionally NOT restored: the cooldown in scanIndexRoot
    // guards against redundant rescans WITHIN a process, but after a restart
    // every persisted root must be rebuilt once.
  } catch {
    // First run / corrupt file: start empty.
  }
  // Rebuild the in-memory name index for every persisted root in the
  // background (Everything re-indexes its scope on startup). Searches then
  // work immediately after a restart; browsing still refreshes on demand.
  for (const root of indexRoots) queueIndexScan(root);
}

function queueIndexPersist() {
  if (indexPersistQueued) return;
  indexPersistQueued = true;
  setTimeout(() => {
    indexPersistQueued = false;
    void (async () => {
      try {
        await mkdir(dirname(indexStateFile), { recursive: true });
        const scannedAt: Record<string, number> = {};
        for (const [root, at] of indexScannedAt) scannedAt[root] = at;
        await writeFile(indexStateFile, JSON.stringify({ roots: [...indexRoots], scannedAt } satisfies IndexPersist));
      } catch {
        // Persisting the index scope is best-effort.
      }
    })();
  }, 500);
}

/** Record a directory as an index root (browsing it makes it persist). */
function rememberIndexRoot(root: string) {
  if (indexRoots.has(root)) return;
  indexRoots.add(root);
  if (indexRoots.size > currentConfig().indexMaxRoots) {
    // Drop the least-recently-scanned root to keep the scope bounded.
    const oldest = [...indexRoots].sort((a, b) => (indexScannedAt.get(a) ?? 0) - (indexScannedAt.get(b) ?? 0))[0];
    if (oldest) indexRoots.delete(oldest);
  }
  queueIndexPersist();
}

function indexRemoveEntries(root: string) {
  for (const [name, entries] of indexByName) {
    const kept = entries.filter((e) => !e.path.startsWith(root + "\\") && !e.path.startsWith(root + "/") && e.path !== root);
    if (kept.length === 0) indexByName.delete(name);
    else if (kept.length !== entries.length) indexByName.set(name, kept);
  }
  // Drop the corresponding by-path entries (parent-child roots may overlap).
  for (const [p, e] of indexByPath) {
    if (e.path.startsWith(root + "\\") || e.path.startsWith(root + "/") || e.path === root) indexByPath.delete(p);
  }
}

function indexAddEntry(entry: IndexEntry) {
  if (indexByPath.has(entry.path)) return; // already indexed by another root
  indexByPath.set(entry.path, entry);
  const key = entry.name.toLowerCase();
  const bucket = indexByName.get(key);
  if (bucket) bucket.push(entry);
  else indexByName.set(key, [entry]);
}

/** Walk one root and rebuild its slice of the in-memory name index. */
async function scanIndexRoot(root: string) {
  const now = Date.now();
  if ((indexScannedAt.get(root) ?? 0) > now - currentConfig().indexScanCooldownMs) return;
  const seen = new Set<string>();
  const ignore = indexIgnoreSet();
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    if (count >= currentConfig().indexMaxEntries || seen.has(dir)) return;
    seen.add(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (locked / permission) — skip silently
    }
    const subs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== "." && entry.name !== "..") continue;
      if (entry.isDirectory() && ignore.has(entry.name)) continue;
      const full = resolve(dir, entry.name);
      if (count >= currentConfig().indexMaxEntries) break;
      if (entry.isDirectory()) {
        indexAddEntry({ name: entry.name, path: full, kind: "dir" });
        subs.push(full);
        count += 1;
      } else if (entry.isSymbolicLink()) {
        // Windows directory junctions are real directories to the user; index
        // them like directories (file symlinks stay out of the index).
        const target = await stat(full).catch(() => null);
        if (!target) continue;
        if (target.isDirectory()) {
          indexAddEntry({ name: entry.name, path: full, kind: "dir" });
          subs.push(full);
          count += 1;
        }
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".review.jsonl")) continue; // sidecar noise
        indexAddEntry({ name: entry.name, path: full, kind: "file" });
        count += 1;
      }
      // Dirents carry type info, so no extra lstat here (fast path).
    }
    for (const sub of subs) await walk(sub);
  };
  indexRemoveEntries(root);
  await walk(root);
  indexScannedAt.set(root, now);
  queueIndexPersist();
}

/** Roots queued for a background scan (coalesced into one pass). */
const indexScanQueue = new Set<string>();
let indexScanTimer: ReturnType<typeof setTimeout> | null = null;

function queueIndexScan(root: string) {
  indexScanQueue.add(root);
  if (indexScanTimer) return;
  indexScanTimer = setTimeout(() => {
    indexScanTimer = null;
    const batch = [...indexScanQueue];
    indexScanQueue.clear();
    void Promise.all(batch.map((r) => scanIndexRoot(r)));
  }, 250);
}

/** Rank a name for query `q`: prefix beats boundary beats substring; shorter wins ties. */
function scoreName(name: string, q: string): number {
  const lower = name.toLowerCase();
  if (lower.startsWith(q)) return 300 - lower.length;
  const idx = lower.indexOf(q);
  if (idx < 0) return -1;
  const boundaryBefore = idx === 0 || /[^a-z0-9]/.test(lower[idx - 1]);
  return (boundaryBefore ? 200 : 100) - idx - lower.length;
}

/** Search the name index. Returns top matches; empty query yields nothing. */
function searchIndex(query: string, limit = 40): IndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ entry: IndexEntry; score: number }> = [];
  for (const [name, entries] of indexByName) {
    if (!name.includes(q)) continue;
    for (const entry of entries) {
      const score = scoreName(entry.name, q);
      if (score < 0) continue;
      scored.push({ entry, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  // Only jumpable targets: directories and Markdown files. Non-md files the
  // index may have picked up (configs, sidecars, binaries) can't be opened by
  // the review page, so showing them would lead to dead clicks.
  return scored
    .filter((s) => s.entry.kind === "dir" || [".md", ".markdown"].includes(extname(s.entry.name).toLowerCase()))
    .slice(0, limit)
    .map((s) => s.entry);
}

/** Ensure a directory is indexed (called whenever the user browses into it). */
function ensureIndexed(dir: string) {
  rememberIndexRoot(dir);
  queueIndexScan(dir);
  // The directory's ancestor chain becomes searchable too — the user reached
  // this dir through them, so jumping back to e.g. OneDrive/Users must work
  // even though those were never scanned as roots. Clicking one scans it.
  rememberAncestors(dir);
}

/** Record each ancestor of `dir` as a searchable directory entry (no scan). */
function rememberAncestors(dir: string) {
  let current = dir;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) break; // filesystem root reached
    indexAddEntry({ name: basename(current), path: current, kind: "dir" });
    current = parent;
  }
}


function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openVerifiedRegularFile(path: string, flags: string, label: string, allowMissing = false) {
  const before = await lstatOrNull(path);
  if (before?.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (before && !before.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  let handle;
  try {
    handle = await open(path, flags as import("node:fs").OpenMode, 0o600);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const [after, opened] = await Promise.all([lstat(path), handle.stat()]);
    if (after.isSymbolicLink() || !after.isFile() || !opened.isFile() || !sameFile(after, opened)) {
      throw new Error(`${label} changed while opening: ${path}`);
    }
    if (before && !sameFile(before, after)) throw new Error(`${label} changed while opening: ${path}`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function acquireSidecarLock(path: string) {
  let compromisedError: unknown;
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 50, factor: 1.2, minTimeout: 20, maxTimeout: 200, randomize: true },
    onCompromised(error: unknown) {
      compromisedError = error;
    },
  });
  return async () => {
    try {
      await release();
    } catch (error) {
      if (!compromisedError) throw error;
    }
    if (compromisedError) throw compromisedError;
  };
}

async function recoverIncompleteTail(path: string) {
  const handle = await openVerifiedRegularFile(path, "r+", "Review sidecar", true);
  if (!handle) return;
  try {
    const source = await handle.readFile();
    if (!source.length || source.at(-1) === 0x0a) return;
    const lastNewline = source.lastIndexOf(0x0a);
    await handle.truncate(lastNewline + 1);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonl(path: string): Promise<Annotation[]> {
  const handle = await openVerifiedRegularFile(path, "r", "Review sidecar", true);
  if (!handle) return [];
  try {
    const source = await handle.readFile("utf8");
    if (!source.trim()) return [];
    const completeSource = source.endsWith("\n") ? source : source.slice(0, source.lastIndexOf("\n") + 1);
    const annotations = new Map<string, Annotation>();
    completeSource.split(/\r?\n/).filter(Boolean).forEach((line, index) => {
      try {
        const annotation = JSON.parse(line) as Annotation;
        if (typeof annotation.id !== "string" || !annotation.id) {
          throw new Error("record has no annotation id");
        }
        annotations.set(annotation.id, annotation);
      } catch {
        throw new Error(`Invalid JSONL record at line ${index + 1}: ${path}`);
      }
    });
    return [...annotations.values()];
  } finally {
    await handle.close();
  }
}

async function appendJsonl(path: string, annotation: Annotation) {
  const handle = await openVerifiedRegularFile(path, "a", "Review sidecar");
  try {
    const record = Buffer.from(`${JSON.stringify(annotation)}\n`, "utf8");
    let offset = 0;
    while (offset < record.length) {
      const { bytesWritten } = await handle.write(record, offset);
      if (!bytesWritten) throw new Error(`Failed to append review annotation: ${path}`);
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readRequestBody(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body exceeds 1 MiB");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnnotationInput;
}

function openInBrowser(url: string) {
  const command = process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

export interface ReviewSession {
  documentPath: string;
  sidecarPath: string;
  url: string;
  mode: "file" | "dir";
  documents?: string[];
  close(): Promise<void>;
}

export type ReviewTarget =
  | { kind: "file"; path: string; baseDirectory: string }
  | { kind: "dir"; path: string; baseDirectory: string };

/**
 * Resolve an input path to either a single Markdown file or a directory.
 * Preserves the single-file behavior (resolveDocumentPath) for backward
 * compatibility.
 */
export async function resolveReviewTarget(inputPath: string, baseDirectory: string): Promise<ReviewTarget> {
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new Error("A Markdown path or directory is required");
  const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(baseDirectory, inputPath);
  try {
    const info = await stat(absolutePath);
    if (info.isDirectory()) return { kind: "dir", path: await realpath(absolutePath), baseDirectory };
    if (info.isFile()) {
      if (![".md", ".markdown"].includes(extname(absolutePath).toLowerCase())) {
        throw new Error("Only .md and .markdown documents can be reviewed");
      }
      const real = await realpath(absolutePath);
      return { kind: "file", path: real, baseDirectory: dirname(real) };
    }
    throw new Error("Review path must point to a file or directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Review path does not exist");
    }
    throw error;
  }
}

/**
 * Resolve a single Markdown file (backward-compatible helper). Throws for
 * directories.
 */
export async function resolveDocumentPath(inputPath: string, baseDirectory: string): Promise<string> {
  const target = await resolveReviewTarget(inputPath, baseDirectory);
  if (target.kind === "dir") {
    throw new Error("Expected a .md or .markdown file, got a directory");
  }
  return target.path;
}

/** Maximum number of Markdown files scanned in directory mode. */
const MAX_DIRECTORY_FILES = 500;

/**
 * Recursively scan a directory for .md/.markdown files, sorted by path. The
 * returned paths are relative to the directory root. node_modules, VCS
 * metadata, and build-output directories are skipped.
 * @param config - optional root-scoped config; defaults to the global view.
 */
export async function scanMarkdownFiles(directoryPath: string, config?: ReviewConfig): Promise<string[]> {
  const ignore = new Set(config?.indexIgnore ?? currentConfig().indexIgnore);
  const results: string[] = [];
  async function walk(dir: string, relPrefix: string): Promise<void> {
    if (results.length >= MAX_DIRECTORY_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (results.length >= MAX_DIRECTORY_FILES) return;
      const full = resolve(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        await walk(full, rel);
      } else if (entry.isFile() && [".md", ".markdown"].includes(extname(entry.name).toLowerCase())) {
        results.push(rel);
      }
    }
  }
  await walk(directoryPath, "");
  return results;
}

export interface AnnotationList {
  documentPath: string;
  sidecarPath: string;
  documentHash: string;
  stale: boolean;
  annotations: Annotation[];
}

export async function listAnnotations(documentPath: string): Promise<AnnotationList> {
  const source = await readFile(documentPath, "utf8");
  const documentHash = hashDocument(source);
  await loadAnnotationStore();
  const annotations = listAnnotationsFromStore(documentPath);
  return {
    documentPath,
    sidecarPath: annotationStoreFile,
    documentHash,
    stale: annotations.some((item) => activeStatuses.has(item.status) && item.documentHash !== documentHash),
    annotations,
  };
}

export async function addAnnotation(documentPath: string, input: AnnotationInput): Promise<Annotation> {
  const normalized = normalizeAnnotationInput(input);
  const source = await readFile(documentPath, "utf8");
  const now = new Date().toISOString();
  const annotation: Annotation = {
    schema: "local-review/v1",
    id: randomUUID(),
    document: documentPath,
    documentHash: hashDocument(source),
    kind: normalized.kind,
    status: normalized.kind === "comment" ? "open" : "pending",
    anchor: normalized.anchor,
    body: normalized.body,
    replacement: normalized.replacement,
    author: "browser",
    createdAt: now,
    updatedAt: now,
  };
  await loadAnnotationStore();
  storeAnnotationsFor(documentPath).set(annotation.id, annotation);
  await appendAnnotationRecord(annotation);
  return annotation;
}

export async function updateAnnotationStatus(documentPath: string, annotationId: string, status: string): Promise<Annotation> {
  await loadAnnotationStore();
  const bucket = annotationStore.get(documentPath.toLowerCase());
  const annotation = bucket?.get(annotationId);
  if (!annotation) throw new Error(`Annotation not found: ${annotationId}`);
  if (!allowedStatuses[annotation.kind]?.has(status)) {
    throw new Error(`Status ${status} is not valid for ${annotation.kind}`);
  }
  const updated: Annotation = {
    ...annotation,
    status: status as Annotation["status"],
    updatedAt: new Date().toISOString(),
  };
  bucket.set(annotationId, updated);
  await appendAnnotationRecord(updated); // append-only: newer record wins
  return updated;
}

/**
 * Permanently delete an annotation from the central store. The store file is
 * rewritten without this annotation's records (the file is small — hundreds
 * of lines — so a rewrite under lock is cheap and safe).
 */
export async function deleteAnnotation(documentPath: string, annotationId: string): Promise<{ deleted: boolean }> {
  await loadAnnotationStore();
  const bucket = annotationStore.get(documentPath.toLowerCase());
  if (!bucket?.has(annotationId)) throw new Error(`Annotation not found: ${annotationId}`);
  bucket.delete(annotationId);
  if (bucket.size === 0) annotationStore.delete(documentPath.toLowerCase());
  // Serialize the rewrite on the same queue used for appends.
  const key = "@store";
  const previous = writeQueues.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const releaseLock = await acquireSidecarLock(annotationStoreFile);
    try {
      await recoverIncompleteTail(annotationStoreFile);
      const lines: string[] = [];
      for (const [docKey, docBucket] of annotationStore) {
        for (const annotation of docBucket.values()) {
          // Persist the exact path from the record, not the case-folded key.
          lines.push(JSON.stringify(annotation));
        }
      }
      lines.sort();
      const dir = dirname(annotationStoreFile);
      await mkdir(dir, { recursive: true });
      const tmp = `${annotationStoreFile}.tmp`;
      await writeFile(tmp, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
      await rename(tmp, annotationStoreFile);
    } finally {
      await releaseLock();
    }
  });
  writeQueues.set(key, operation as Promise<unknown>);
  try {
    await operation;
  } finally {
    if (writeQueues.get(key) === operation) writeQueues.delete(key);
  }
  return { deleted: true };
}

export interface ReviewServerOptions {
  baseDirectory?: string;
  port?: number;
  openBrowser?: boolean;
  idleTimeoutMs?: number;
  /** Live plugin config; defaults to the module's current snapshot. */
  config?: ReviewConfig;
}

interface ReviewServerInstance {
  server: Server;
  port: number;
  writeToken: string;
  url: string;
  baseDirectory: string;
  rootPath: string;
  lastActivity: number;
  idleTimeoutMs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  documents: string[];
  rootKind: "file" | "dir";
}

let activeInstance: ReviewServerInstance | undefined;

function armIdleWatchdog(instance: ReviewServerInstance) {
  if (instance.idleTimer) clearTimeout(instance.idleTimer);
  instance.idleTimer = setTimeout(() => {
    // Re-arm unless the singleton truly sat idle long enough.
    if (activeInstance !== instance) return;
    if (Date.now() - instance.lastActivity >= instance.idleTimeoutMs) {
      void stopReviewServer();
    } else {
      armIdleWatchdog(instance);
    }
  }, instance.idleTimeoutMs);
  instance.idleTimer.unref?.();
}

function touch(instance: ReviewServerInstance) {
  instance.lastActivity = Date.now();
  armIdleWatchdog(instance);
}

function sessionFor(instance: ReviewServerInstance): ReviewSession {
  const primary = instance.documents[0] ?? instance.baseDirectory;
  return {
    documentPath: primary,
    sidecarPath: annotationStoreFile,
    url: instance.url,
    mode: instance.rootKind,
    documents: instance.documents,
    async close() {
      await stopReviewServer();
    },
  };
}

/** Stop the singleton review server and release its port. */
export async function stopReviewServer(): Promise<boolean> {
  const instance = activeInstance;
  if (!instance) return false;
  activeInstance = undefined;
  if (instance.idleTimer) clearInterval(instance.idleTimer);
  if (instance.server.listening) {
    await new Promise<void>((resolveClose, reject) => {
      instance.server.close((error) => (error ? reject(error) : resolveClose()));
    });
  }
  return true;
}

/** Whether the singleton review server is currently running. */
export function isReviewServerRunning(): boolean {
  return Boolean(activeInstance && activeInstance.server.listening);
}

/** Start (or reuse) the singleton review server. Never one port per file. */
export async function createReviewServer(inputPath: string, options: ReviewServerOptions = {}): Promise<ReviewSession> {
  if (options.config) applyReviewConfig(options.config);
  // Restore the persisted index scope once per process (cheap, idempotent).
  if (!indexRoots.size) await loadIndexState();
  await loadAnnotationStore();
  // One-time background migration of legacy sidecars (imports then removes
  // them). Scope: every persisted index root plus this session's root, so
  // notes on files the user has touched anywhere on the machine get picked up.
  const migrationRoots = new Set([...indexRoots, resolve(inputPath)]);
  void migrateLegacySidecars(migrationRoots);
  const baseDirectory = resolve(options.baseDirectory || process.cwd());
  const target = await resolveReviewTarget(inputPath, baseDirectory);
  const rootPath = target.path;
  // Root-scoped config: persisted workspace overrides sit on top of the
  // global (and entry-config) snapshot for this root's server.
  const merged = configForRoot(rootPath);

  // Reuse the running singleton; just re-point its root and refresh the scan.
  if (activeInstance && activeInstance.server.listening) {
    const instance = activeInstance;
    instance.baseDirectory = baseDirectory;
    instance.rootPath = rootPath;
    instance.documents = target.kind === "dir"
      ? await scanMarkdownFiles(rootPath, merged)
      : [rootPath];
    instance.rootKind = target.kind;
    instance.idleTimeoutMs = merged.idleTimeoutMinutes * 60 * 1000;
    armIdleWatchdog(instance);
    touch(instance);
    if (options.openBrowser ?? merged.openBrowserOnStart) openInBrowser(instance.url);
    return sessionFor(instance);
  }

  const writeToken = randomBytes(24).toString("base64url");
  let allowedHost: string | undefined;
  let allowedOrigin: string | undefined;
  let lastActivity = Date.now();

  const instance: ReviewServerInstance = {
    server: null as unknown as Server,
    port: 0,
    writeToken,
    url: "",
    baseDirectory,
    rootPath,
    lastActivity,
    idleTimeoutMs: options.idleTimeoutMs ?? merged.idleTimeoutMinutes * 60 * 1000,
    documents: target.kind === "dir" ? await scanMarkdownFiles(rootPath, merged) : [rootPath],
    rootKind: target.kind,
  };

  const server: Server = createServer(async (request, response) => {
    touch(instance);
    securityHeaders(response);
    try {
      if (!allowedHost || request.headers.host !== allowedHost) {
        return json(response, 421, { error: "Invalid review host" });
      }
      if (request.headers.origin && request.headers.origin !== allowedOrigin) {
        return json(response, 403, { error: "Invalid review origin" });
      }
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json(response, 200, { ok: true, root: instance.rootPath, documents: instance.documents.length });
      }
      // Configuration surface: read the merged snapshot (global + workspace
      // for this root), and write either level. Writes need the review token.
      if (request.method === "GET" && url.pathname === "/api/config") {
        const merged = configForRoot(instance.rootPath);
        return json(response, 200, {
          root: instance.rootPath,
          global: globalOverrides,
          workspace: workspaceOverrides[instance.rootPath] ?? {},
          effective: merged,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/config/global") {
        if (request.headers["x-review-token"] !== writeToken) return json(response, 403, { error: "Invalid review token" });
        const body = await readRequestBody(request) as { config?: Partial<ReviewConfig> };
        const saved = await saveGlobalConfig(body.config ?? {});
        return json(response, 200, { saved, effective: currentConfig() });
      }
      if (request.method === "POST" && url.pathname === "/api/config/workspace") {
        if (request.headers["x-review-token"] !== writeToken) return json(response, 403, { error: "Invalid review token" });
        const body = await readRequestBody(request) as { config?: Partial<ReviewConfig> };
        const saved = await saveWorkspaceConfig(instance.rootPath, body.config ?? {});
        const merged = configForRoot(instance.rootPath);
        return json(response, 200, { root: instance.rootPath, saved, effective: merged });
      }
      // Filesystem navigation: list a directory (defaults to the review root).
      // `::computer` lists every drive — the "This PC" level that lets the
      // page reach files outside the workspace.
      if (request.method === "GET" && url.pathname === "/api/fs/list") {
        const requested = url.searchParams.get("path") || instance.rootPath;
        if (requested === THIS_PC) {
          const listing = await listDirectoryEntries(THIS_PC, instance.baseDirectory, instance.rootPath);
          return json(response, 200, listing);
        }
        const dirPath = await normalizeFsPath(requested, instance.baseDirectory);
        ensureIndexed(dirPath); // browsing a directory grows the persistent index scope
        const listing = await listDirectoryEntries(dirPath, instance.baseDirectory, instance.rootPath);
        return json(response, 200, listing);
      }
      // Everything-style quick search over the persisted filename index.
      if (request.method === "GET" && url.pathname === "/api/fs/search") {
        const query = url.searchParams.get("q") || "";
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 40));
        const results = searchIndex(query, limit);
        return json(response, 200, { query, results });
      }
      // Documents under the current root (kept for the list view).
      if (request.method === "GET" && url.pathname === "/api/documents") {
        const documents = await Promise.all(instance.documents.map(async (rel) => {
          const full = resolve(rootPath, rel);
          const source = await readFile(full, "utf8");
          const review = await listAnnotations(full);
          return {
            path: rel,
            title: titleFromMarkdown(source, full),
            openCount: review.annotations.filter((a) => activeStatuses.has(a.status)).length,
          };
        }));
        return json(response, 200, { mode: "dir", directory: rootPath, documents });
      }
      if (request.method === "GET" && url.pathname === "/api/document") {
        const requested = url.searchParams.get("path") || null;
        const documentPath = requested
          ? await normalizeFsPath(requested, instance.baseDirectory, true)
          : await resolveReviewDocumentPath(requested, instance);
        const source = await readFile(documentPath, "utf8");
        const review = await listAnnotations(documentPath);
        // The document's own directory chain, so the breadcrumb bar reflects
        // where the opened file lives even when reached via quick search.
        const dir = dirname(documentPath);
        return json(response, 200, {
          ...review,
          title: titleFromMarkdown(source, documentPath),
          html: markdown.render(source),
          writeToken,
          mode: "dir",
          root: instance.rootPath,
          dir,
          parent: parentOf(dir),
          crumbs: ancestryCrumbs(dir),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/annotations") {
        if (request.headers["x-review-token"] !== writeToken) return json(response, 403, { error: "Invalid review token" });
        const body = await readRequestBody(request);
        const requested = (body as { documentPath?: string }).documentPath || url.searchParams.get("path") || null;
        const documentPath = await normalizeFsPath(requested || "", instance.baseDirectory, true);
        const annotation = await addAnnotation(documentPath, body);
        return json(response, 201, annotation);
      }
      const annotationMatch = url.pathname.match(/^\/api\/annotations\/([^/]+)$/);
      if (request.method === "PATCH" && annotationMatch) {
        if (request.headers["x-review-token"] !== writeToken) return json(response, 403, { error: "Invalid review token" });
        const body = await readRequestBody(request) as { status?: string };
        const requested = url.searchParams.get("path") || null;
        const documentPath = await normalizeFsPath(requested || "", instance.baseDirectory, true);
        const annotation = await updateAnnotationStatus(documentPath, decodeURIComponent(annotationMatch[1]), body.status || "");
        return json(response, 200, annotation);
      }
      if (request.method === "DELETE" && annotationMatch) {
        if (request.headers["x-review-token"] !== writeToken) return json(response, 403, { error: "Invalid review token" });
        const requested = url.searchParams.get("path") || null;
        const documentPath = await normalizeFsPath(requested || "", instance.baseDirectory, true);
        const result = await deleteAnnotation(documentPath, decodeURIComponent(annotationMatch[1]));
        return json(response, 200, result);
      }
      if (request.method === "GET" && ["/", "/index.html", "/app.js", "/styles.css"].includes(url.pathname)) {
        const fileName = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const contentType = fileName.endsWith(".css") ? "text/css; charset=utf-8" : fileName.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
        response.writeHead(200, { "Content-Type": contentType });
        return response.end(await readFile(resolve(publicDirectory, fileName)));
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      json(response, 400, { error: (error as Error).message });
    }
  });
  instance.server = server;

  // Bind: try the preferred port, then the next few.
  const { preferredPort, maxPortTries } = merged;
  let bound = false;
  for (let attempt = 0; attempt < maxPortTries; attempt++) {
    const candidate = options.port ?? preferredPort + attempt;
    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(candidate, "127.0.0.1", resolveListen);
      });
      bound = true;
      instance.port = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      // Port taken; try the next one.
    }
  }
  if (!bound) throw new Error("No free port available for the review server");

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind review server");
  allowedHost = `127.0.0.1:${address.port}`;
  allowedOrigin = `http://${allowedHost}`;
  instance.url = `http://127.0.0.1:${address.port}`;
  activeInstance = instance;

  // Idle watchdog: close the server (release the port) after idleTimeoutMs of
  // no requests. The browser page keeps it alive with a periodic /api/health;
  // each request re-arms the timer, so there is no periodic wake-up.
  armIdleWatchdog(instance);

  if (options.openBrowser ?? merged.openBrowserOnStart) openInBrowser(instance.url);
  return sessionFor(instance);
}

/** Resolve a filesystem path against the workspace root; `mustBeFile` enforces a real regular file. */
async function normalizeFsPath(requested: string, baseDirectory: string, mustBeFile = false): Promise<string> {
  if (!requested.trim()) throw new Error("A path is required");
  if (requested === THIS_PC) return THIS_PC;
  let absolute: string;
  if (isAbsolute(requested)) {
    absolute = resolve(requested);
  } else {
    absolute = resolve(baseDirectory, requested);
  }
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) {
    // Windows directory junctions (OneDrive redirects, "Application Data",
    // user-profile links) report as symlinks from Dirent/lstat but are
    // legitimate directory aliases the user must be able to browse. Follow
    // only when the target is a real directory; file symlinks stay refused.
    const target = await stat(absolute).catch(() => null);
    if (!target || !target.isDirectory()) {
      throw new Error(`Refusing symbolic-link path: ${absolute}`);
    }
  }
  if (mustBeFile) {
    if (!info.isFile()) throw new Error(`Not a file: ${absolute}`);
    if (![".md", ".markdown"].includes(extname(absolute).toLowerCase())) {
      throw new Error(`Not a Markdown file: ${absolute}`);
    }
  }
  return absolute;
}

/** Parent of a directory path, or the "This PC" level above a drive root. */
function parentOf(dirPath: string): string | null {
  if (dirPath === THIS_PC) return null;
  const parent = dirname(dirPath);
  if (parent === dirPath) return THIS_PC; // drive root / filesystem root -> This PC
  return parent;
}

/** A breadcrumb row or a listed directory row. */
interface FsEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  /** Dot-prefixed (hidden) entry; the client decides whether to show it. */
  hidden?: boolean;
  /** Open (pending) annotation count for a Markdown file; 0 for directories. */
  openCount?: number;
}

/** One level of a directory listing, mirroring DSH's DirectoryListing shape. */
interface FsListing {
  /** Absolute path of the listed directory, or THIS_PC for the virtual drive level. */
  path: string;
  /** The review root the page started from (the workspace); "" on the virtual level. */
  root: string;
  /** Parent navigation target (null at the top). */
  parent: string | null;
  /** Ancestor chain from the filesystem root to the listed path inclusive; every one is a jump target. */
  crumbs: FsEntry[];
  /** Direct children (directories + Markdown files), name-sorted. */
  entries: FsEntry[];
  /** Sum of open annotation counts across this level's Markdown files (the page's header tally). */
  openTotal: number;
}

/** Count open (pending) annotations for a Markdown file from the central store; none = 0. */
async function countOpenAnnotations(documentPath: string): Promise<number> {
  await loadAnnotationStore();
  return listAnnotationsFromStore(documentPath).filter((item) => activeStatuses.has(item.status)).length;
}

/** List one directory level: the virtual "This PC" (all drives) or a real directory. */
async function listDirectoryEntries(dirPath: string, baseDirectory: string, rootPath: string): Promise<FsListing> {
  if (dirPath === THIS_PC) {
    return {
      path: THIS_PC,
      root: rootPath,
      parent: null,
      crumbs: [{ name: "此电脑", path: THIS_PC }],
      entries: await listDrives(),
      openTotal: 0,
    };
  }
  const info = await lstat(dirPath);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);
  const entries = await readdir(dirPath, { withFileTypes: true });
  const dirs: FsEntry[] = [];
  const files: FsEntry[] = [];
  for (const entry of entries) {
    // Dot-prefixed entries are marked hidden and let the client decide, so
    // `.github`, `.git` and the like stay reachable when the user asks.
    const hidden = entry.name.startsWith(".");
    const full = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: full, kind: "dir", hidden });
    } else if (entry.isSymbolicLink()) {
      // Windows directory junctions (OneDrive redirects, user-profile links)
      // surface as symlinks from Dirent. Follow the target: directories are
      // browsable; file symlinks stay refused (see normalizeFsPath).
      const target = await stat(full).catch(() => null);
      if (!target) continue;
      if (target.isDirectory()) {
        dirs.push({ name: entry.name, path: full, kind: "dir", hidden });
      } else if (target.isFile() && [".md", ".markdown"].includes(extname(entry.name).toLowerCase())) {
        const openCount = await countOpenAnnotations(full);
        files.push({ name: entry.name, path: full, kind: "file", openCount, hidden });
      }
    } else if (entry.isFile() && [".md", ".markdown"].includes(extname(entry.name).toLowerCase())) {
      const openCount = await countOpenAnnotations(full);
      files.push({ name: entry.name, path: full, kind: "file", openCount, hidden });
    }
  }
  const byName = (a: FsEntry, b: FsEntry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  dirs.sort(byName);
  files.sort(byName);
  return {
    path: dirPath,
    root: rootPath,
    parent: parentOf(dirPath),
    crumbs: ancestryCrumbs(dirPath),
    entries: [...dirs, ...files],
    openTotal: files.reduce((sum, file) => sum + (file.openCount ?? 0), 0),
  };
}

/** Resolve the review document from a rel path against the current root (kept for /api/document without ?path=). */
async function resolveReviewDocumentPath(rel: string | null, instance: ReviewServerInstance): Promise<string> {
  if (rel) return normalizeFsPath(rel, instance.baseDirectory, true);
  if (instance.documents[0]) return resolve(instance.baseDirectory, instance.documents[0]);
  throw new Error("No Markdown document available");
}
