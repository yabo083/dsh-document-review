# dsh-document-review

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for reviewing Markdown documents in a local browser — word by word.

Select text in the rendered document to add a **comment**, suggest a **replacement**, or suggest **deletion**. The browser never edits the Markdown source; annotations are stored in one central append-only store at `~/.dsh-document-review/annotations.jsonl`, so annotations on files anywhere on the machine — inside or outside the workspace — are all visible to the agent with a single tool call.

Adapted from [opencode-document-review](https://github.com/yabo083/opencode-document-review) — the same review core (HTTP server, security model), wrapped as DSH model-facing tools instead of OpenCode tools, with annotations consolidated into a central store.

## Why

DSH agents author and edit Markdown a lot — architecture docs, ADRs, READMEs, plans. "Review this document word by word" is a natural request, but DSH had no plugin for it (confirmed: no document-review/annotation plugin in the market as of 2026-08). This plugin fills that gap.

The agent opens the document in a local browser; the human reviews and annotates; the agent reads the annotations back and applies changes through its normal file-editing tools.

## Tools

All four tools are registered on `ctx.tools` and become model-facing:

| Tool | Purpose |
|---|---|
| `document_review_start` | Start or reuse a local review session for a Markdown **file or directory** (directory mode reviews every `.md` file inside). Returns the browser URL. |
| `document_review_list` | Read review annotations (open/pending by default, or all). **Without `path`, returns every annotation across all documents on the machine** — the single call the agent needs after "审查完了你看下". Includes source-hash staleness. In directory mode, summarizes every document. |
| `document_review_update` | Mark a comment (resolved/open) or suggestion (accepted/rejected/pending) as handled. |
| `document_review_stop` | Stop the local review session. Annotations remain in the central store. |

## Settings

Configuration follows the official DSH plugin pattern: export a Schemastery
`Config` schema, configure from `cordis.yml` (per-entry `config:` block), and
additionally register the same schema as a DSH settings namespace
(`document-review`) for runtime overrides.

In the harness Web profile's `cordis.patch.yml`, add a `config` block to the
plugin's entry:

```yaml
- id: document-review
  name: dsh-document-review
  config:
    preferredPort: 15600
    idleTimeoutMinutes: 60
    indexIgnore:
      - node_modules
      - .git
      - dist
```

Changing the `config` block hot-replaces the plugin via HMR. A DSH settings
user document (when present) overrides individual keys on top of the
`cordis.yml` base; without one, the entry config applies as-is.

### In-page settings panel (review page)

Open any review page and click the gear button (top-right) for a settings
dialog with two levels:

- **全局设置** — applies to every workspace. Persisted to
  `~/.dsh-document-review/config.json`, layered above the `cordis.yml` base.
- **当前工作区设置** — applies only to the workspace the review page is
  rooted at. Persisted to `~/.dsh-document-review/workspace-configs.json`
  (keyed by root path), layered above the global settings.

Effective value = defaults → `cordis.yml` → 全局设置 → 当前工作区设置.
Index limits apply immediately (next scan); port and idle-timeout values apply
on the next session start. **恢复默认** clears the active level's overrides.

| Key | Default | Effect |
|---|---|---|
| `preferredPort` | 15580 | First port to try for the review server; auto-increments when taken |
| `maxPortTries` | 20 | Ports tried before giving up |
| `idleTimeoutMinutes` | 30 | Idle time before the singleton server auto-shuts down |
| `openBrowserOnStart` | true | Open the review page when a session starts |
| `indexMaxRoots` | 64 | Filename-index roots remembered (LRU) |
| `indexMaxEntries` | 60000 | Filename-index entry cap |
| `indexScanCooldownMs` | 30000 | Min interval between full rescans of one root |
| `indexIgnore` | node_modules, .git, dist, … | Directory names skipped by indexing, migration, and directory scans |

Index limits apply immediately; port and idle-timeout values apply on the next
session start.

## Install (published package)

```sh
dsh plugin --profile web add dsh-document-review
dsh --profile web
```

The plugin declares `dsh.bundle` (host tools + HTTP route) and `dsh.client`
(浏览器「审阅」面板): the review page, the model-facing tools, and the
per-Workspace「文档审阅」menu entries in the DSH sidebar all ship in one package.

## Install (development)

From a DSH repository checkout:

```sh
dsh web --patch /absolute/path/to/dsh-document-review/cordis.yml
```

Open `http://127.0.0.1:3080` and ask the agent: *"Review the document at /path/to/file.md word by word."*

The `cordis.yml` overlay inserts the plugin into the Web profile. The path in `cordis.yml` must be absolute; edit it to match your checkout location.

## Browser review page

The review page renders the Markdown read-only. Select any text to annotate:

- **Comment** — a note with no replacement.
- **Suggest replacement** — propose new text for the selection.
- **Suggest deletion** — mark the selection for removal.

Annotations appear in a side panel. Each one carries `textQuote` anchors and a
SHA-256 hash of the source, so the agent can verify the document hasn't changed
underneath the review (`stale: true` otherwise). The agent reads annotations
back via `document_review_list`, applies changes to the source, and marks them
resolved/accepted/rejected.

## Directory mode

Pass a directory path to `document_review_start` (or the HTTP route) to review
many Markdown files in one session:

- The page lists every `.md`/`.markdown` file (recursive, sorted; `node_modules`,
  `.git`, and build-output directories are skipped; capped at 500 files).
- Click a file to render it; navigation (back/forward/breadcrumb/path jump) is
  the same file-manager UI as a single-file open.
- Each document keeps its own `<document>.review.jsonl` sidecar.
- `document_review_update` accepts a `documentPath` argument (relative within the directory) to address a specific file's annotation.

## HTTP routes (GUI launcher)

The client launcher calls host routes to start the review page without the model:

```
GET  /api/v2/document-review/scan?path=<directory>   (compat; the page browses via /api/fs/list)
POST /api/v2/document-review/start
     { "path": "/abs/or/relative/path", "openBrowser": false }
```

`start` returns `{ reused, mode, documentPath, sidecarPath, url, documents }`.
Both routes are registered on the harness web server (`ctx.webServer`, with an
`httpServer` fallback for older deployments) and are re-registered
idempotently when the web-server service binds after this plugin's `apply`.

Inside the review page (port 15580), the settings dialog uses:

```
GET  /api/config                       (merged snapshot for this root)
POST /api/config/global                (write global overrides; needs review token)
POST /api/config/workspace             (write this root's overrides; needs review token)
```

## Browser launcher (client plugin)

Every **Workspace row in the DSH sidebar** gets a「文档审阅」entry inside its
ellipsis menu:

- Open a Workspace row's `⋯` menu and choose **文档审阅** to open the review
  page rooted at **that workspace's directory** (`ctx.workspaces` → workspace
  `path`).
- The sidebar exposes no per-row slot, so the entry is injected into the
  portaled menu list via a MutationObserver keyed on the workspace row menu
  button (`工作区“{name}”的操作` / `Workspace actions for {name}`), which
  exists only on real Workspace rows — the ungrouped bucket is skipped, and
  session-row menus never get the entry.
- The review server is a **singleton** — one server, one port (15580, with
  fallbacks), reused across opens. It shuts down automatically after 30 minutes
  without traffic, and the page keeps it alive with a lightweight heartbeat
  while open, so no port is permanently occupied.
- Styling rides the DSH `--dsw-*` design tokens, so the injected menu item
  matches the host chrome in both light and dark themes.

## Review page — file-manager browser + review

The review page is a lightweight two-mode UI:

- **File browser** (default): toolbar with back / forward / up / refresh, a
  history dropdown, and a **quick-open search box** (VS Code style — Ctrl+P to
  focus). Breadcrumbs run from the filesystem root through a「此电脑」level (all
  drives), so you can browse **anywhere on the machine** — including drives
  outside the workspace (e.g. OneDrive on `C:` while the workspace lives on
  `E:`). Directories and Markdown files are listed; clicking a directory enters
  it, clicking a document opens the review view. The workspace is just the
  starting point, not a boundary.
- **Review view**: the rendered document with the full annotation UI — select
  text to comment / suggest replacement / suggest deletion; the side panel
  lists annotations with locate, resolve, accept, and reject actions.
- **Quick search** is backed by an Everything-style filename index (names
  only, never contents) whose scope is *the directories you actually browse*,
  persisted to `~/.dsh-document-review/index-state.json`. Typing filters the
  in-memory name map (prefix beats substring); ↑/↓ navigate, Enter opens, Esc
  closes. Common noise directories (`node_modules`, `.git`, `dist`, `cache`,
  dot-entries, …) and `.review.jsonl` sidecars are skipped.
- Back / forward history is a front-end stack (Alt+← / Alt+→, mouse side
  buttons, and the 🕘 dropdown all work), so navigation never touches the server.
- A status dot shows the singleton server's health; if it idles out, refresh
  the page to restart it.

The page consumes these APIs on the singleton server:

```
GET  /api/health              singleton status (root, document count); heartbeat target
GET  /api/fs/list?path=<dir>  one directory: subdirectories + Markdown files, breadcrumb ancestry, parent;
                             `::computer` lists every drive (the「此电脑」level)
GET  /api/fs/search?q=<q>     quick search over the persisted filename index (max 50 hits)
GET  /api/document?path=<abs> render one Markdown document + its annotations
POST /api/annotations         add an annotation (X-Review-Token required)
PATCH /api/annotations/:id    update an annotation status (X-Review-Token required)
DELETE /api/annotations/:id   permanently delete an annotation (X-Review-Token required)
```

## Data contract

- Any explicit absolute `.md` or `.markdown` path readable by the current OS user can be reviewed.
- Relative paths resolve from the agent's current working directory.
- Review records live in one central append-only JSONL store: `~/.dsh-document-review/annotations.jsonl`.
- Status updates append a new record with the same annotation ID; reads dedupe by ID, latest wins.
- Deleting an annotation rewrites the store without it (physical removal).
- Legacy `<document>.review.jsonl` sidecars from older versions are auto-imported and removed on first start.
- Records contain quote anchors, a source SHA-256 hash, status, timestamps, and optional replacement text.
- Source changes are applied by the agent through normal DSH file-editing tools, not by the browser.

## Security

The HTTP server binds only to `127.0.0.1`, validates the loopback `Host` and same-origin requests, uses a random write token, disables CORS, and serves the selected Markdown rendering, one-level directory listings, and bundled static assets. The browser only lists directory names and reads Markdown files; every other filesystem surface is closed. Store writes use a cross-process lock and reject symbolic-link sidecars.

## Structure

```
dsh-document-review/
├── src/
│   ├── index.ts          DSH host entry: 4 tools on ctx.tools + HTTP start route + Config schema
│   ├── config.ts         Schemastery Config schema + defaults (cordis.yml + DSH settings)
│   ├── review.ts         Review core: HTTP server, central JSONL store, security
│   ├── web-server.ts     Minimal structural type for ctx.webServer routes
│   └── client/
│       └── index.tsx     Browser entry: per-Workspace「审阅」buttons (dsh.client)
├── public/
│   ├── index.html        Review page shell
│   ├── app.js            Selection → annotation UI (file + directory modes)
│   └── styles.css        Review page styles
├── cordis.patch.yml      Bundle patch: inserts the plugin row (dsh plugin add)
├── cordis.yml            DSH Web dev overlay (edit path to match your location)
├── tsconfig.json         Host program (src/, excludes src/client)
├── tsconfig.client.json  Browser program (src/client, jsx: react-jsx)
├── tsdown.config.ts      Client bundle build (DSH __ModuleLoader__ protocol)
├── scripts/copy-assets.mjs
├── package.json
└── README.md
```

## Build

```sh
npm install          # dev tooling (tsdown, lightningcss, react, typescript)
npm run build        # host tsc → lib/, client tsc → lib/client/, tsdown → lib/client.js
npm run check        # type-check both programs without emitting
```

The client bundle is emitted as a CJS closure-factory artifact:
`window.__ModuleLoader__.load({ id: "dsh-document-review", factory: (require) => … })`
with `react`, `react-dom`, and the other platform modules resolved through the
shell's frozen module table, exactly like DSH's own `packages/client/ui-*` bundles.

## License

MIT
