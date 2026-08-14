/**
 * DSH plugin: Document Review.
 *
 * Opens a Markdown document in a local browser for word-by-word review.
 * Select text to add a comment, suggest a replacement, or suggest deletion.
 * The browser never edits the Markdown source; all annotations are stored in
 * one central append-only file, ~/.dsh-document-review/annotations.jsonl,
 * so the agent can list notes on ANY reviewed document (inside or outside the
 * working directory) with a single call.
 *
 * Tools registered on ctx.tools (model-facing):
 *   - document_review_start: start or reuse a local review session.
 *   - document_review_list:  read active or all review annotations (omit
 *                            `path` to get every note across all documents).
 *   - document_review_update: mark a comment or suggestion handled.
 *   - document_review_stop:  stop a local review session.
 *
 * Adapted from opencode-document-review (github:yabo083/opencode-document-review).
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type JsonValue } from "@deepseek-ai/dsh-tools";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { resolve } from "node:path";
import {
  applyReviewConfig,
  createReviewServer,
  isReviewServerRunning,
  listAllAnnotations,
  listAnnotations,
  loadPersistedConfigs,
  refreshActiveInstanceConfig,
  resolveReviewTarget,
  scanMarkdownFiles,
  stopReviewServer,
  updateAnnotationStatus,
  type ReviewSession,
} from "./review.js";
import {
  DEFAULT_REVIEW_CONFIG,
  REVIEW_SETTINGS_NAMESPACE,
  ReviewSettingsSchema,
  type ReviewConfig,
} from "./config.js";
import type { WebRouteHost } from "./web-server.js";

export const name = "dsh-document-review";
export const inject = ["tools"];

/**
 * Official Cordis configuration schema: users configure the plugin from
 * `cordis.yml` (entry `config:` block). The DSH settings seam additionally
 * registers the same schema per-namespace, so a future settings panel or a
 * user document can override individual keys at runtime.
 */
export const Config = ReviewSettingsSchema;

/** Latest config snapshot; refreshed from the settings panel on change. */
let latestConfig: ReviewConfig = DEFAULT_REVIEW_CONFIG;

interface ReviewState {
  // The review server is a singleton; this tracks its creation promise so
  // unload can close it.
  active: Promise<ReviewSession> | null;
}

function result(value: unknown) {
  return JSON.stringify(value, null, 2);
}

/** Read an HTTP request body as JSON, bounded. */
async function readJsonBody(req: import("node:http").IncomingMessage, maxBytes: number): Promise<{ path?: string; openBrowser?: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { path?: string; openBrowser?: boolean };
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

/** Start or reuse the singleton review server for an absolute path. */
async function startSession(
  state: ReviewState,
  absolutePath: string,
  openBrowser: boolean,
): Promise<{ reused: boolean; session: ReviewSession }> {
  const reused = isReviewServerRunning();
  const sessionPromise = createReviewServer(absolutePath, {
    openBrowser,
    baseDirectory: process.cwd(),
    // The live plugin config snapshot (settings panel or defaults).
    config: latestConfig,
  });
  state.active = sessionPromise;
  sessionPromise.catch(() => {
    if (state.active === sessionPromise) state.active = null;
  });
  const session = await sessionPromise;
  return { reused, session };
}

export function apply(ctx: Context, config: ReviewConfig = DEFAULT_REVIEW_CONFIG) {
  const state: ReviewState = { active: null };
  // Entry-config (cordis.yml) is the composition base; the settings user
  // document (when present) overrides individual keys on top of it.
  latestConfig = { ...DEFAULT_REVIEW_CONFIG, ...config };
  applyReviewConfig(latestConfig);
  // Restore user-persisted global + per-workspace settings (review page).
  void loadPersistedConfigs().then(() => {
    applyReviewConfig(latestConfig);
    refreshActiveInstanceConfig();
  });

  ctx.inject(["settings"], (settingsCtx) => {
    try {
      const scope = settingsCtx.settings.register(
        settingsNamespace(REVIEW_SETTINGS_NAMESPACE),
        ReviewSettingsSchema,
        { base: latestConfig },
      );
      latestConfig = scope.get();
      applyReviewConfig(latestConfig);
      scope.watch((next) => {
        latestConfig = next;
        applyReviewConfig(next);
      });
    } catch {
      // A duplicate or rejected registration must not take the plugin down;
      // the review server keeps its defaults.
    }
  });

  // Stop the singleton review server when the plugin unloads.
  ctx.effect(() => {
    return async () => {
      await stopReviewServer();
      state.active = null;
    };
  });

  // HTTP routes for the browser panel. The web-server service may bind after
  // this plugin's apply (concurrent sibling activation), so (re)register when
  // it appears or later.
  const registerRoutes = () => {
    const web = (ctx.get("webServer") ?? ctx.get("httpServer")) as WebRouteHost | undefined;
    if (!web) return;
    const disposers: Array<() => void> = [];

    disposers.push(web.register({
      kind: "exact",
      path: "/api/v2/document-review/start",
      handler: async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        try {
          const body = await readJsonBody(req, 1_048_576);
          const target = await resolveReviewTarget(body.path ?? "", process.cwd());
          const { reused, session } = await startSession(state, target.path, body.openBrowser !== false);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            reused,
            mode: session.mode,
            documentPath: session.documentPath,
            sidecarPath: session.sidecarPath,
            url: session.url,
            documents: session.documents ?? [],
          }));
        } catch (error) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: { code: "INVALID_REQUEST", message: (error as Error).message } }));
        }
      },
    }));

    // Scan a directory for reviewable Markdown files (the panel's file list).
    disposers.push(web.register({
      kind: "exact",
      path: "/api/v2/document-review/scan",
      handler: async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        try {
          const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
          const raw = url.searchParams.get("path") ?? "";
          const target = await resolveReviewTarget(raw, process.cwd());
          if (target.kind !== "dir") {
            throw new Error("scan expects a directory path");
          }
          const relPaths = await scanMarkdownFiles(target.path);
          const documents = relPaths.map((rel) => {
            const title = rel.split(/[\\/]/).pop() ?? rel;
            return { path: rel, title };
          });
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ directory: target.path, documents }));
        } catch (error) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: { code: "INVALID_REQUEST", message: (error as Error).message } }));
        }
      },
    }));

    return () => {
      for (const dispose of disposers) dispose();
    };
  };
  ctx.effect(() => {
    let dispose = registerRoutes();
    // internal/service fires when a service binds; web-server may bind after
    // this plugin, so (re)register idempotently when it appears.
    ctx.on("internal/service", (name: string) => {
      if ((name === "webServer" || name === "httpServer") && !dispose) {
        dispose = registerRoutes();
      }
    });
    return () => {
      dispose?.();
    };
  }, "dsh-document-review: routes");


  ctx.tools.register(defineTool({
    name: "document_review_start",
    description:
      "Open a local browser review page for Markdown content: either a single .md file or a whole directory of Markdown files. The source stays read-only; annotations are written beside each document as .review.jsonl. Use this when the user wants to review, proofread, or annotate Markdown word by word in a browser.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Absolute Markdown file or directory path, or a path relative to the current working directory",
      },
      openBrowser: {
        type: "boolean",
        description: "Open the system browser after starting the local server. Defaults to true.",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: result(value) }],
    },
    async execute(args, exec) {
      const target = await resolveReviewTarget(args.path, process.cwd());
      const { reused, session } = await startSession(state, target.path, args.openBrowser !== false);
      return {
        reused,
        mode: session.mode,
        documentPath: session.documentPath,
        sidecarPath: session.sidecarPath,
        url: session.url,
        documents: session.documents ?? [],
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "document_review_list",
    description:
      "Read structured review annotations. Without `path`, returns EVERY annotation on EVERY reviewed document the user has touched — inside or outside the working directory (the store lives in ~/.dsh-document-review/annotations.jsonl). With `path`, returns annotations for that one document, including source-hash staleness. Closed (resolved/accepted/rejected) annotations are omitted by default. Use this when the user says they are done reviewing and asks you to look at the notes.",
    parameters: {
      path: {
        type: "string",
        description: "Optional absolute Markdown path, or a path relative to the current working directory. Omit to list all annotations across every reviewed document.",
      },
      includeClosed: {
        type: "boolean",
        description: "Include resolved, accepted, and rejected annotations. Defaults to false.",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: result(value) }],
    },
    async execute(args) {
      // No path: the global view the user asked for — every note, everywhere.
      if (typeof args.path !== "string" || !args.path.trim()) {
        const groups = await listAllAnnotations();
        const all = groups.flatMap((group) =>
          group.annotations.map((a) => ({ documentPath: group.documentPath, ...a })),
        );
        const visible = args.includeClosed
          ? all
          : all.filter((item) => item.status === "open" || item.status === "pending");
        const open = all.filter((item) => item.status === "open" || item.status === "pending").length;
        return {
          mode: "all",
          total: all.length,
          open,
          documents: groups.length,
          annotations: visible,
        } as unknown as JsonValue;
      }
      const target = await resolveReviewTarget(args.path, process.cwd());
      if (target.kind === "file") {
        const review = await listAnnotations(target.path);
        const annotations = args.includeClosed
          ? review.annotations
          : review.annotations.filter((item) => item.status === "open" || item.status === "pending");
        return { mode: "file", ...review, annotations } as unknown as JsonValue;
      }
      // Directory mode: summarize every document.
      const relPaths = await scanMarkdownFiles(target.path);
      const summaries = await Promise.all(relPaths.map(async (rel) => {
        const full = resolve(target.path, rel);
        const review = await listAnnotations(full);
        const annotations = args.includeClosed
          ? review.annotations
          : review.annotations.filter((item) => item.status === "open" || item.status === "pending");
        return {
          path: rel,
          documentPath: full,
          sidecarPath: review.sidecarPath,
          documentHash: review.documentHash,
          stale: review.stale,
          annotations,
          openCount: review.annotations.filter((item) => item.status === "open" || item.status === "pending").length,
        } as unknown as JsonValue;
      }));
      return { mode: "dir", directory: target.path, documents: summaries } as JsonValue;
    },
  }));

  ctx.tools.register(defineTool({
    name: "document_review_update",
    description:
      "Update one review annotation after it has been handled. Comments use resolved/open; suggestions (replace/delete) use accepted/rejected/pending. Use this to mark a review note as resolved after applying the suggested change to the source.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Absolute Markdown path or directory, or a path relative to the current working directory",
      },
      documentPath: {
        type: "string",
        description: "In directory mode, the relative path (within the directory) of the document owning the annotation. Ignored in single-file mode.",
      },
      annotationId: {
        type: "string",
        required: true,
        description: "The annotation id to update",
      },
      status: {
        type: "string",
        required: true,
        enum: ["open", "resolved", "pending", "accepted", "rejected"],
        description: "New status: comments use open/resolved; suggestions use pending/accepted/rejected",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: result(value) }],
    },
    async execute(args) {
      const target = await resolveReviewTarget(args.path, process.cwd());
      const documentPath = target.kind === "file"
        ? target.path
        : resolve(target.path, args.documentPath || "");
      const annotation = await updateAnnotationStatus(documentPath, args.annotationId, args.status);
      return { id: annotation.id, status: annotation.status, updatedAt: annotation.updatedAt };
    },
  }));

  ctx.tools.register(defineTool({
    name: "document_review_stop",
    description:
      "Stop the local browser review server (a singleton: one server serves the whole review page, so this stops it regardless of which path was opened last). Review annotations remain on disk. Use this when the user is done reviewing and wants to close the local server and release its port.",
    parameters: {
      path: {
        type: "string",
        description: "Optional Markdown path (kept for compatibility; the singleton server is stopped either way)",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: result(value) }],
    },
    async execute(args) {
      const path = typeof args.path === "string" ? args.path : "";
      const stopped = await stopReviewServer();
      state.active = null;
      return {
        stopped,
        documentPath: path ? (await resolveReviewTarget(path, process.cwd())).path : null,
        reason: stopped ? null : "No active review server",
      } as JsonValue;
    },
  }));
}
