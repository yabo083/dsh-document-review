/**
 * Client half of dsh-document-review: a「文档审阅」entry inside every
 * Workspace row's ellipsis menu in the DSH sidebar. Clicking it opens the
 * review page (a file-manager-style browser with word-level review) rooted at
 * that Workspace's directory.
 *
 * The sidebar exposes no per-row or per-menu slot, so the entry is injected
 * into the portaled menu list via a MutationObserver: when a Workspace row's
 * ellipsis menu opens (the row menu button aria-label `工作区"{name}"的操作` /
 * `Workspace actions for {name}` exists only on real Workspace rows), a
 * document-review item is appended to the `[role="menu"]` list. Rows render in
 * the same order as `ctx.workspaces.list` items — the Nth row maps to
 * items[N].path.
 *
 * Styling rides the DSH design tokens (`--dsw-*`), so the injected menu item
 * matches the host chrome in both light and dark themes.
 */

import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";

export const inject = ["sessions", "workspaces"];

const MENU_CSS = `
.dvv-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #f5f6f7);
  font: 400 14px/22px var(--dsw-font-family, system-ui, sans-serif);
  text-align: left;
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease);
}
.dvv-menu-item:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08));
}
.dvv-menu-item:disabled { opacity: .4; cursor: not-allowed; }
.dvv-menu-item svg { width: 16px; height: 16px; flex: none; }
.dvv-menu-item .dvv-menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dvv-row-toast {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  max-width: 340px;
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #2c2c2e);
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  color: var(--dsw-alias-label-secondary, #d3d7dc);
  font: 12px/1.5 var(--dsw-font-family, system-ui, sans-serif);
  word-break: break-all;
  animation: dvv-toast-in .15s ease;
}
@keyframes dvv-toast-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.dvv-row-toast.dvv-error { color: var(--dsw-alias-state-error-primary, #f25a5a); }
`;

/** Lucide-style "book-open-check": a document with a checkmark — review. */
const REVIEW_ICON_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>
</svg>`;

interface StartResult {
  reused?: boolean;
  mode?: string;
  url?: string;
  error?: { code?: string; message?: string };
}

/** Live workspace paths by DOM row index; kept in sync via the workspaces store. */
class RowIndex {
  paths: string[] = [];
  titles: string[] = [];

  update(items: Array<{ path: string; title: string }>): void {
    this.paths = items.map((item) => item.path);
    this.titles = items.map((item) => item.title);
  }
}

export function apply(ctx: ClientContext): void {
  // Stylesheet once.
  if (!document.querySelector("style[data-document-vault-review]")) {
    const style = document.createElement("style");
    style.dataset.documentVaultReview = "";
    style.textContent = MENU_CSS;
    document.head.appendChild(style);
  }

  const row = new RowIndex();
  // Keep the workspace path/title table in sync with the Host baseline.
  const sync = (): void => {
    const snapshot = ctx.workspaces.list.getSnapshot();
    if (snapshot && snapshot.items) {
      row.update(snapshot.items as Array<{ path: string; title: string }>);
    }
  };
  sync();
  ctx.workspaces.list.subscribe(sync);

  // Toast surface (only mounted on first use).
  let toastHost: HTMLDivElement | null = null;
  let toastTimer: number | undefined;
  const toast = (text: string, error: boolean): void => {
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.style.cssText = "position:fixed;top:0;left:0;pointer-events:none;z-index:2147483000";
      document.body.appendChild(toastHost);
    }
    const p = document.createElement("p");
    p.className = `dvv-row-toast${error ? " dvv-error" : ""}`;
    p.textContent = text;
    toastHost.appendChild(p);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { p.remove(); }, 4000);
  };

  // Which Workspace row opened the currently visible menu (path + title), set
  // on the ellipsis click and cleared when that menu is gone.
  let pendingPath: string | undefined;
  let pendingTitle: string | undefined;

  // Windows we opened; the host pushes theme flips into them via postMessage.
  const openedWindows = new Set<Window>();

  /** Host dark state: the `data-ds-dark-theme` attribute (exists = dark). */
  const hostDark = (): boolean => document.body.hasAttribute("data-ds-dark-theme");

  const startReview = async (path: string): Promise<void> => {
    try {
      const response = await fetch("/api/v2/document-review/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, openBrowser: false }),
        cache: "no-store",
      });
      const result = (await response.json()) as StartResult;
      if (!response.ok || result.error) {
        toast(result.error?.message || `启动失败 (${response.status})`, true);
        return;
      }
      if (result.url) {
        // Seed the review page with the host theme on open; later flips are
        // pushed through the postMessage bridge below.
        const separator = result.url.includes("?") ? "&" : "?";
        const themed = `${result.url}${separator}theme=${hostDark() ? "dark" : "light"}`;
        // NB: no `noopener` — we need the WindowProxy to push theme changes
        // into the review window. The review page is our own trusted page.
        const win = window.open(themed, "_blank");
        if (win) {
          openedWindows.add(win);
          const poll = window.setInterval(() => {
            if (win.closed) {
              window.clearInterval(poll);
              openedWindows.delete(win);
            }
          }, 30_000);
        }
      }
    } catch (error) {
      toast((error as Error).message, true);
    }
  };

  // Bridge host theme changes into every review window we opened. The review
  // page is a separate origin (127.0.0.1:15580), so it cannot read the host
  // body attribute itself; postMessage is the only live channel.
  const pushTheme = (): void => {
    const dark = hostDark();
    for (const win of [...openedWindows]) {
      if (win.closed) { openedWindows.delete(win); continue; }
      try { win.postMessage({ source: "dsh-document-review", type: "theme", dark }, "*"); } catch { /* cross-origin ignore */ }
    }
  };
  new MutationObserver(pushTheme).observe(document.body, {
    attributes: true,
    attributeFilter: ["data-ds-dark-theme"],
  });

  // Capture the ellipsis click: the workspace menu button only exists on real
  // Workspace rows, and the Nth menu button maps to row.paths[N]. Any other
  // menu click (session rows, settings, etc.) clears the pending target so a
  // later-opened menu never inherits a stale workspace.
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest?.("button[aria-label]") as HTMLButtonElement | null;
    if (!button) return;
    const label = button.getAttribute("aria-label") || "";
    const isWorkspaceMenu =
      label.includes("工作区") && label.includes("的操作") ||
      label.startsWith("Workspace actions for");
    if (!isWorkspaceMenu) {
      // A non-workspace menu trigger (session row, settings, …) — clear any
      // stale workspace target so only workspace menus get the entry.
      pendingPath = undefined;
      pendingTitle = undefined;
      return;
    }
    const clusters = document.querySelectorAll("button[aria-label]");
    let index = -1;
    let seen = 0;
    for (const el of clusters) {
      const elLabel = (el as HTMLButtonElement).getAttribute("aria-label") || "";
      const isWs = elLabel.includes("工作区") && elLabel.includes("的操作") ||
        elLabel.startsWith("Workspace actions for");
      if (!isWs) continue;
      if (el === button) { index = seen; break; }
      seen += 1;
    }
    pendingPath = index >= 0 ? row.paths[index] : undefined;
    pendingTitle = index >= 0 ? row.titles[index] : undefined;
  }, true);

  // Inject the review item into any opened Workspace menu.
  const injectMenus = (): void => {
    const menus = document.querySelectorAll("[role='menu']");
    for (const menu of menus) {
      if (menu.querySelector("[data-dvv-review]")) continue;
      if (pendingPath === undefined) continue;
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.dataset.dvvReview = "";
      item.className = "dvv-menu-item";
      item.title = pendingTitle ? `文档审阅（${pendingTitle}）` : "文档审阅";
      item.innerHTML = `${REVIEW_ICON_SVG}<span class="dvv-menu-label">文档审阅</span>`;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const path = pendingPath;
        if (!path) return;
        item.disabled = true;
        void startReview(path).finally(() => { item.disabled = false; });
      });
      menu.appendChild(item);
    }
  };

  const observer = new MutationObserver(() => { injectMenus(); });
  observer.observe(document.body, { childList: true, subtree: true });
  injectMenus();

  ctx.effect(() => () => {
    observer.disconnect();
    toastHost?.remove();
  }, "dsh-document-review: workspace-menu entries");
}
