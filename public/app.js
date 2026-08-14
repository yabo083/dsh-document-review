/* Document Review — file-manager style browser + word-level review.
 * The review server is a singleton on the machine (127.0.0.1). This page
 * keeps it alive with a periodic /api/health ping, so it shuts down
 * automatically when the tab is closed. Navigation (back/forward/breadcrumb/
 * path jump) is a pure front-end history stack.
 */
const state = {
  // review
  annotations: [], anchor: null, kind: "comment", showAll: false, token: "", ranges: new Map(),
  currentPath: null, composerPath: null,
  // browser
  root: null, dir: null, parent: null, crumbs: [], entries: [],
  history: [], historyIndex: -1,
  connected: true,
  // show dot-prefixed (hidden) entries; synced from the effective config.
  showHidden: false,
}
const elements = Object.fromEntries([
  "annotation-body", "annotation-list", "body-label", "browser-empty", "browser-error", "browser-path",
  "breadcrumbs", "composer", "composer-error", "composer-title", "document", "empty-state",
  "file-browser", "file-list", "nav-history", "open-count", "open-count-label", "path-root",
  "replacement", "replacement-field", "review-view", "selected-quote", "selection-toolbar",
  "search-form", "search-input", "search-panel", "search-results", "search-status",
  "status-dot", "theme-toggle", "title", "toggle-filter",
  "nav-back", "nav-forward", "nav-up", "nav-refresh", "settings-toggle",
].map((id) => [id.replaceAll("-", "_"), document.querySelector(`#${id}`)]))
const labels = {
  comment: "批注", replace: "建议替换", delete: "建议删除", open: "待处理", pending: "待处理",
  accepted: "已采纳", resolved: "已解决", rejected: "已拒绝",
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(state.token ? { "X-Review-Token": state.token } : {}), ...options.headers },
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || "请求失败")
  return value
}

function isActive(annotation) { return annotation.status === "open" || annotation.status === "pending" }
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = value || ""; return node.innerHTML }

// ---------- inline lucide icons (replaces emoji) ----------
// Strokes inherit `currentColor`, so they follow the active theme automatically.
const I = {
  "arrow-left": `<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>`,
  "arrow-right": `<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`,
  "arrow-up": `<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>`,
  refresh: `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>`,
  history: `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>`,
  folder: `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
  "file-text": `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`,
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>`,
  moon: `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`,
  trash: `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>`,
  settings: `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
}
function iconSvg(name, size = 16) {
  const paths = I[name]
  if (!paths) return ""
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
}
// Fill every `[data-icon="name"]` placeholder with its inline SVG.
function mountIcons() {
  document.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = iconSvg(el.dataset.icon) })
}

// ---------- navigation history ----------

// Guards against out-of-order responses: every navigation bumps this; stale
// responses (an earlier click arriving after a newer one) are discarded.
let navRequestSeq = 0

function pushHistory(entry) {
  state.history = state.history.slice(0, state.historyIndex + 1)
  state.history.push(entry)
  state.historyIndex = state.history.length - 1
  updateNavButtons()
}

function updateNavButtons() {
  elements.nav_back.disabled = state.historyIndex <= 0
  elements.nav_forward.disabled = state.historyIndex >= state.history.length - 1
}

function goBack() {
  if (state.historyIndex <= 0) return
  state.historyIndex -= 1
  navigateTo(state.history[state.historyIndex], { record: false })
}

function goForward() {
  if (state.historyIndex >= state.history.length - 1) return
  state.historyIndex += 1
  navigateTo(state.history[state.historyIndex], { record: false })
}

async function navigateTo(entry, { record = true } = {}) {
  if (!entry) return
  try {
    if (entry.type === "dir") await openDirectory(entry.path, { record })
    else if (entry.type === "file") await openDocument(entry.path, { record })
  } catch (error) {
    showBrowserError(error.message)
  }
}

// ---------- file browser ----------

function dirName(path) { return String(path).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path }

function basename(path) { return String(path).split(/[\\/]/).pop() || path }

function renderBreadcrumbs() {
  if (!state.dir) { elements.breadcrumbs.innerHTML = ""; return }
  // Crumbs come from the server (ancestryCrumbs), rooted at the filesystem
  // root (`C:\`, `/`) — the mature cross-drive chain. We only prepend a
  // "此电脑" entry above the root so any drive stays reachable.
  const crumbs = state.crumbs && state.crumbs.length
    ? state.crumbs
    : [{ name: state.dir, path: state.dir }]
  const html = ['<button type="button" class="crumb" data-path="::computer" title="所有磁盘">此电脑</button>']
  for (const crumb of crumbs) {
    html.push(`<button type="button" class="crumb" data-path="${escapeHtml(crumb.path)}" title="${escapeHtml(crumb.path)}">${escapeHtml(crumb.name)}</button>`)
  }
  elements.breadcrumbs.innerHTML = html.join('<span class="crumb-sep">/</span>')
  for (const crumb of elements.breadcrumbs.querySelectorAll(".crumb")) {
    crumb.addEventListener("click", () => {
      const path = crumb.dataset.path
      if (path === "::computer") openDirectory("::computer")
      else openDirectory(path)
    })
  }
}

function isInside(child, parent) {
  const c = child.replace(/[\\/]+$/, "").toLowerCase()
  const p = parent.replace(/[\\/]+$/, "").toLowerCase()
  return c === p || c.startsWith(p + "/") || c.startsWith(p + "\\")
}

function renderFileList() {
  elements.file_list.innerHTML = ""
  const visible = state.entries.filter((e) => !e.hidden || state.showHidden)
  const dirs = visible.filter((e) => e.kind === "dir")
  const files = visible.filter((e) => e.kind === "file")
  const rows = []
  for (const entry of dirs) {
    rows.push(`<li><button class="file-row dir" type="button" data-path="${escapeHtml(entry.path)}" title="${escapeHtml(entry.path)}">
      <span class="file-icon">${iconSvg("folder", 17)}</span><span class="file-name">${escapeHtml(entry.name)}</span><span class="file-kind">目录</span>
    </button></li>`)
  }
  for (const entry of files) {
    const badge = entry.openCount > 0
      ? `<span class="open-badge" title="待处理批注 ${entry.openCount} 条">${entry.openCount}</span>`
      : ""
    rows.push(`<li><button class="file-row md" type="button" data-path="${escapeHtml(entry.path)}" title="${escapeHtml(entry.path)}">
      <span class="file-icon">${iconSvg("file-text", 17)}</span><span class="file-name">${escapeHtml(entry.name)}</span>${badge}<span class="file-kind">Markdown</span>
    </button></li>`)
  }
  elements.file_list.innerHTML = rows.join("")
  for (const row of elements.file_list.querySelectorAll(".file-row")) {
    row.addEventListener("click", () => {
      const path = row.dataset.path
      if (row.classList.contains("dir")) openDirectory(path)
      else openDocument(path)
    })
    row.addEventListener("dblclick", () => {
      const path = row.dataset.path
      if (row.classList.contains("md")) openDocument(path)
    })
  }
  elements.browser_empty.hidden = rows.length > 0
  elements.browser_error.hidden = true
}

async function openDirectory(path, { record = true } = {}) {
  closeComposer() // never carry a pending note across a view switch
  const seq = ++navRequestSeq
  elements.file_browser.classList.add("loading")
  let list
  try {
    list = await api(`/api/fs/list?path=${encodeURIComponent(path)}`)
  } catch (error) {
    elements.file_browser.classList.remove("loading")
    if (seq !== navRequestSeq) return // superseded by a newer navigation
    showBrowserError(error.message)
    return
  }
  if (seq !== navRequestSeq) return
  elements.file_browser.classList.remove("loading")
  state.dir = list.path
  state.root = list.root || state.root
  state.parent = list.parent ?? null
  state.crumbs = list.crumbs || []
  state.entries = list.entries
  elements.browser_path.textContent = list.path === "::computer" ? "此电脑" : list.path
  elements.file_browser.hidden = false
  elements.review_view.hidden = true
  elements.path_root.textContent = state.root && list.path !== "::computer" ? dirName(state.root) : ""
  // Directory view: the header tally = all pending annotations in this level
  // (the sum across every Markdown file the server computed).
  elements.open_count.textContent = String(list.openTotal ?? 0)
  elements.open_count_label.textContent = "待处理"
  renderBreadcrumbs()
  renderFileList()
  document.title = `${list.path === "::computer" ? "此电脑" : dirName(list.path)} · 文档审阅`
  if (record) pushHistory({ type: "dir", path: list.path })
  else updateNavButtons()
}

async function openDocument(path, { record = true } = {}) {
  closeComposer() // never carry a pending note across a view switch
  const seq = ++navRequestSeq
  elements.review_view.classList.add("loading")
  let review
  try {
    review = await api(`/api/document?path=${encodeURIComponent(path)}`)
  } catch (error) {
    elements.review_view.classList.remove("loading")
    if (seq !== navRequestSeq) return // superseded by a newer navigation
    // Keep whatever view is up, but surface the failure — in document view
    // the inline browser-error element is hidden, so fall back to the toast.
    if (elements.file_browser.hidden) showToast(`打开失败：${error.message}`)
    else showBrowserError(error.message)
    return
  }
  if (seq !== navRequestSeq) return
  elements.review_view.classList.remove("loading")
  state.token = review.writeToken
  state.annotations = review.annotations
  state.currentPath = review.documentPath
  // Keep the breadcrumb bar in sync with where this file lives, so quick
  // search jumps (and any navigation) always show the right chain.
  if (review.dir) {
    state.dir = review.dir
    state.parent = review.parent ?? null
    state.crumbs = review.crumbs || []
  }
  elements.file_browser.hidden = true
  elements.review_view.hidden = false
  document.title = `${review.title} · 文档审阅`
  elements.document.innerHTML = review.html
  elements.open_count.textContent = String(state.annotations.filter(isActive).length)
  elements.browser_path.textContent = review.documentPath
  elements.path_root.textContent = state.root ? dirName(state.root) : ""
  renderBreadcrumbs()
  renderAnnotations()
  if (record) pushHistory({ type: "file", path: review.documentPath })
  else updateNavButtons()
}

function showBrowserError(message) {
  elements.browser_error.hidden = false
  elements.browser_error.textContent = message
}

// Lightweight toast for save feedback (does not need the DSH chrome).
let toastTimer = null
function showToast(message) {
  let toast = document.querySelector("#review-toast")
  if (!toast) {
    toast = document.createElement("div")
    toast.id = "review-toast"
    document.body.appendChild(toast)
  }
  toast.textContent = message
  toast.classList.add("visible")
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200)
}

// ---------- annotations ----------

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []
  let offset = 0
  while (walker.nextNode()) {
    const node = walker.currentNode
    const start = offset
    offset += node.nodeValue.length
    nodes.push({ node, start, end: offset })
  }
  return { nodes, text: nodes.map((entry) => entry.node.nodeValue).join("") }
}

function rangeAt(nodes, start, end) {
  const first = nodes.find((entry) => entry.start <= start && entry.end >= start)
  const last = nodes.find((entry) => entry.start < end && entry.end >= end)
  if (!first || !last) return null
  const range = new Range()
  range.setStart(first.node, start - first.start)
  range.setEnd(last.node, end - last.start)
  return range
}

function locateAnchor(anchor) {
  const quote = anchor.textQuote
  const { nodes, text } = textNodes(elements.document)
  let searchFrom = 0
  let best = null
  while (searchFrom <= text.length) {
    const start = text.indexOf(quote.exact, searchFrom)
    if (start < 0) break
    const before = text.slice(Math.max(0, start - quote.prefix.length), start)
    const after = text.slice(start + quote.exact.length, start + quote.exact.length + quote.suffix.length)
    const score = Number(Boolean(quote.prefix) && before === quote.prefix) + Number(Boolean(quote.suffix) && after === quote.suffix)
    if (!best || score > best.score) best = { start, end: start + quote.exact.length, score }
    if (score === 2) break
    searchFrom = start + Math.max(1, quote.exact.length)
  }
  return best ? rangeAt(nodes, best.start, best.end) : null
}

function paintHighlights() {
  state.ranges.clear()
  const comments = []
  const suggestions = []
  for (const annotation of state.annotations.filter(isActive)) {
    const range = locateAnchor(annotation.anchor)
    if (!range) continue
    state.ranges.set(annotation.id, range)
    if (annotation.kind === "comment") comments.push(range)
    else suggestions.push(range)
  }
  if (globalThis.CSS?.highlights) {
    CSS.highlights.clear()
    if (comments.length) CSS.highlights.set("review-comment", new Highlight(...comments))
    if (suggestions.length) CSS.highlights.set("review-suggestion", new Highlight(...suggestions))
  }
}

function annotationCard(annotation) {
  const active = isActive(annotation)
  const statusLabel = labels[annotation.status] || annotation.status
  // Original core state flow (from opencode-document-review): comments toggle
  // open/resolved; suggestions toggle pending/rejected, and accepted ones have
  // no action button.
  const nextStatus = annotation.kind === "comment"
    ? (active ? "resolved" : "open")
    : (active ? "rejected" : "pending")
  const actionLabel = annotation.kind === "comment"
    ? (active ? "标记已解决" : "重新打开")
    : (active ? "拒绝建议" : "重新打开")
  const action = annotation.status === "accepted" ? "" : `<button class="update-status ghost-button" data-status="${nextStatus}" type="button">${actionLabel}</button>`
  const deleteButton = `<button class="delete-note ghost-button danger-text" type="button" title="永久删除这条批注">${iconSvg("trash", 13)}</button>`
  const quote = escapeHtml(annotation.anchor.textQuote.exact)
  const body = annotation.body ? `<p class="body">${escapeHtml(annotation.body)}</p>` : ""
  const replacement = annotation.kind === "replace"
    ? `<div class="replacement"><span>替换为</span><p>${escapeHtml(annotation.replacement)}</p></div>` : ""
  const stale = active && !state.ranges.has(annotation.id) ? `<span class="stale">未定位</span>` : ""
  return `<article class="annotation-card ${active ? "active" : "closed"}" data-id="${escapeHtml(annotation.id)}">
    <div class="card-head">
      <span class="badge kind-${annotation.kind}">${labels[annotation.kind] || annotation.kind}</span>
      <span class="badge status-${annotation.status}">${statusLabel}</span>
      ${stale}
      <button class="locate ghost-button" type="button">定位</button>
    </div>
    <blockquote class="quote">${quote}</blockquote>
    ${body}
    ${replacement}
    <div class="actions">${action}${deleteButton}</div>
  </article>`
}

function renderAnnotations() {
  paintHighlights()
  const visible = state.showAll ? state.annotations : state.annotations.filter(isActive)
  elements.annotation_list.innerHTML = visible.map(annotationCard).join("")
  elements.empty_state.hidden = visible.length > 0
  elements.open_count.textContent = String(state.annotations.filter(isActive).length)
  elements.toggle_filter.textContent = state.showAll ? "仅看待处理" : "显示全部"
  for (const card of elements.annotation_list.querySelectorAll(".annotation-card")) {
    const id = card.dataset.id
    card.querySelector(".locate").addEventListener("click", () => {
      const range = state.ranges.get(id) || locateAnchor(state.annotations.find((item) => item.id === id).anchor)
      range?.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" })
    })
    card.querySelector(".update-status")?.addEventListener("click", async (event) => {
      try {
        const query = state.currentPath ? `?path=${encodeURIComponent(state.currentPath)}` : ""
        const updated = await api(`/api/annotations/${encodeURIComponent(id)}${query}`, { method: "PATCH", body: JSON.stringify({ status: event.currentTarget.dataset.status }) })
        state.annotations = state.annotations.map((item) => item.id === id ? updated : item)
        renderAnnotations()
      } catch (error) { alert(error.message) }
    })
    card.querySelector(".delete-note")?.addEventListener("click", async () => {
      const quote = (state.annotations.find((item) => item.id === id)?.anchor.textQuote.exact || "").slice(0, 40)
      if (!confirm(`永久删除这条批注？\n\n引用：${quote}`)) return
      try {
        const query = state.currentPath ? `?path=${encodeURIComponent(state.currentPath)}` : ""
        await api(`/api/annotations/${encodeURIComponent(id)}${query}`, { method: "DELETE" })
        state.annotations = state.annotations.filter((item) => item.id !== id)
        renderAnnotations()
        showToast("批注已删除")
      } catch (error) { alert(error.message) }
    })
  }
}

function selectedAnchor() {
  const selection = getSelection()
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const container = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer
  if (!elements.document.contains(container)) return null
  const exact = range.toString()
  if (!exact.trim()) return null
  const beforeRange = new Range()
  beforeRange.selectNodeContents(elements.document)
  beforeRange.setEnd(range.startContainer, range.startOffset)
  const fullText = elements.document.textContent
  const start = beforeRange.toString().length
  return { textQuote: { exact, prefix: fullText.slice(Math.max(0, start - 64), start), suffix: fullText.slice(start + exact.length, start + exact.length + 64) } }
}

function showSelectionToolbar(range) {
  const box = range.getBoundingClientRect()
  const toolbar = elements.selection_toolbar
  toolbar.hidden = false
  const left = Math.min(window.innerWidth - toolbar.offsetWidth - 12, Math.max(12, box.left + box.width / 2 - toolbar.offsetWidth / 2))
  toolbar.style.left = `${left}px`
  // Default: float above the selection. If there is no room above (selection
  // near the top edge), flip below it so the toolbar never covers the text
  // the user is still reading.
  const above = box.top - toolbar.offsetHeight - 10
  const below = box.bottom + 10
  toolbar.style.top = above >= 12
    ? `${above}px`
    : `${Math.min(window.innerHeight - toolbar.offsetHeight - 12, below)}px`
}

function openComposer(kind) {
  state.kind = kind
  // Lock the composer to the document it was opened against. If the user
  // switches files while composing, the pending note must NOT be saved to
  // the wrong document — see closeComposer() on view switches.
  state.composerPath = state.currentPath
  elements.composer.hidden = false
  elements.composer_title.textContent = labels[kind]
  elements.selected_quote.textContent = state.anchor.textQuote.exact
  elements.replacement_field.hidden = kind !== "replace"
  elements.body_label.textContent = kind === "comment" ? "批注" : "说明（可选）"
  elements.annotation_body.value = ""
  elements.replacement.value = ""
  elements.composer_error.textContent = ""
  elements.selection_toolbar.hidden = true
  elements.annotation_body.focus()
}

function closeComposer() {
  elements.composer.hidden = true
  state.anchor = null
  state.composerPath = null
  getSelection()?.removeAllRanges()
}

elements.document.addEventListener("mouseup", () => setTimeout(() => {
  const anchor = selectedAnchor()
  if (!anchor) return void (elements.selection_toolbar.hidden = true)
  state.anchor = anchor
  showSelectionToolbar(getSelection().getRangeAt(0))
}))
// Links inside the rendered document must not hijack the review page: open
// them in a new tab (anchor-only links stay in-page).
elements.document.addEventListener("click", (event) => {
  const target = event.target
  const link = target && target.closest ? target.closest("a") : null
  if (!link) return
  const href = link.getAttribute("href") || ""
  if (!href || href.startsWith("#")) return // same-page anchor: leave default
  event.preventDefault()
  window.open(href, "_blank", "noopener,noreferrer")
})
for (const button of elements.selection_toolbar.querySelectorAll("button")) {
  button.addEventListener("mousedown", (event) => event.preventDefault())
  button.addEventListener("click", () => openComposer(button.dataset.kind))
}
document.querySelector("#save-annotation").addEventListener("click", async () => {
  const docPath = state.composerPath || state.currentPath
  if (!docPath) {
    elements.composer_error.textContent = "尚未打开文档，无法保存批注"
    return
  }
  const button = document.querySelector("#save-annotation")
  button.disabled = true
  elements.composer_error.textContent = ""
  try {
    const annotation = await api("/api/annotations", { method: "POST", body: JSON.stringify({ kind: state.kind, anchor: state.anchor, body: elements.annotation_body.value, replacement: elements.replacement.value, documentPath: docPath }) })
    state.annotations.push(annotation)
    closeComposer()
    renderAnnotations()
    showToast(`已保存批注（${state.annotations.filter(isActive).length} 条待处理）`)
  } catch (error) {
    elements.composer_error.textContent = `保存失败：${error.message}`
  } finally {
    button.disabled = false
  }
})
document.querySelector("#close-composer").addEventListener("click", closeComposer)
document.querySelector("#cancel-composer").addEventListener("click", closeComposer)
elements.toggle_filter.addEventListener("click", () => { state.showAll = !state.showAll; renderAnnotations() })
window.addEventListener("scroll", () => { elements.selection_toolbar.hidden = true }, { passive: true })
window.addEventListener("resize", () => { elements.selection_toolbar.hidden = true })

// ---------- toolbar wiring ----------

elements.nav_back.addEventListener("click", goBack)
elements.nav_forward.addEventListener("click", goForward)
elements.nav_up.addEventListener("click", () => {
  if (!state.dir) return
  // The server computes the parent (drive roots jump to "此电脑", so the
  // page can cross drives and reach files outside the workspace).
  const parent = state.dir === "::computer" ? null : (state.parent ?? null)
  if (parent === null) return
  openDirectory(parent)
})
elements.nav_refresh.addEventListener("click", () => {
  if (state.currentPath && !elements.review_view.hidden) openDocument(state.currentPath, { record: false })
  else if (state.dir) openDirectory(state.dir, { record: false })
})
// ---------- quick-open search (VS Code style, backed by the filename index) ----------

let searchTimer = null
let searchResults = []
let searchIndex = -1
let searchRequestSeq = 0

function searchOpen() {
  elements.search_panel.hidden = false
  renderSearch()
  requestAnimationFrame(() => elements.search_input.focus())
}

function searchClose() {
  elements.search_panel.hidden = true
  searchResults = []
  searchIndex = -1
  elements.search_input.blur()
}

function renderSearch() {
  const list = elements.search_results
  list.innerHTML = ""
  if (searchResults.length === 0) {
    elements.search_status.hidden = false
    elements.search_status.textContent = elements.search_input.value.trim() ? "无匹配结果" : "输入关键词搜索文件（基于已浏览目录的索引）"
    return
  }
  elements.search_status.hidden = true
  const fragment = document.createDocumentFragment()
  searchResults.forEach((item, i) => {
    const li = document.createElement("li")
    const button = document.createElement("button")
    button.type = "button"
    button.className = `search-item ${i === searchIndex ? "selected" : ""}`
    button.innerHTML = `<span class="search-ic">${iconSvg(item.kind === "dir" ? "folder" : "file-text", 15)}</span><span class="search-name">${escapeHtml(item.name)}</span><span class="search-path">${escapeHtml(item.path)}</span><span class="search-kind">${item.kind === "dir" ? "目录" : "Markdown"}</span>`
    button.addEventListener("click", () => { searchIndex = i; searchActivate() })
    li.appendChild(button)
    fragment.appendChild(li)
  })
  list.appendChild(fragment)
}

function searchActivate() {
  const item = searchResults[searchIndex]
  if (!item) return
  searchClose()
  if (item.kind === "dir") openDirectory(item.path)
  else openDocument(item.path)
}

function runSearch() {
  const q = elements.search_input.value.trim()
  if (!q) {
    searchResults = []
    searchIndex = -1
    renderSearch()
    return
  }
  const seq = ++searchRequestSeq
  fetch(`/api/fs/search?q=${encodeURIComponent(q)}&limit=50`, { cache: "no-store" })
    .then((r) => r.ok ? r.json() : Promise.reject(new Error("search failed")))
    .then((data) => {
      if (seq !== searchRequestSeq) return
      searchResults = data.results || []
      searchIndex = searchResults.length ? 0 : -1
      renderSearch()
    })
    .catch(() => { /* transient; keep the previous results */ })
}

elements.search_input.addEventListener("input", () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, 120) // debounce like VS Code quick open
})
elements.search_input.addEventListener("focus", () => {
  if (!elements.search_panel.hidden) return
  // Show the panel immediately with whatever is typed so far.
  elements.search_panel.hidden = false
  renderSearch()
})
elements.search_input.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.stopPropagation(); searchClose(); return }
  if (event.key === "ArrowDown") { event.preventDefault(); searchIndex = Math.min(searchResults.length - 1, searchIndex + 1); renderSearch(); return }
  if (event.key === "ArrowUp") { event.preventDefault(); searchIndex = Math.max(0, searchIndex - 1); renderSearch(); return }
  if (event.key === "Enter") { event.preventDefault(); searchActivate(); return }
  if (event.key === "Tab") { event.preventDefault(); searchActivate(); return }
})
document.addEventListener("click", (event) => {
  if (!elements.search_panel.hidden && !elements.search_panel.contains(event.target) && event.target !== elements.search_input && event.target !== elements.search_form) {
    searchClose()
  }
})
// Ctrl+P focuses quick open from anywhere (VS Code muscle memory).
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
    event.preventDefault()
    searchOpen()
  }
})

// Mouse side buttons (button 3 = back, button 4 = forward) anywhere in the page.
window.addEventListener("auxclick", (event) => {
  if (event.button === 3) { event.preventDefault(); goBack() }
  else if (event.button === 4) { event.preventDefault(); goForward() }
})

// ---------- history dropdown ----------

const historyDropdown = document.createElement("div")
historyDropdown.className = "history-dropdown"
historyDropdown.hidden = true
document.body.appendChild(historyDropdown)

function renderHistory() {
  if (state.history.length === 0) { historyDropdown.hidden = true; return }
  historyDropdown.innerHTML = ""
  const header = document.createElement("div")
  header.className = "history-head"
  header.textContent = "浏览历史"
  historyDropdown.appendChild(header)
  const back = [...state.history].slice(0, state.historyIndex + 1).reverse()
  const forward = state.history.slice(state.historyIndex + 1)
  let shown = 0
  for (const entry of [...back, ...forward]) {
    if (shown >= 30) break
    const item = document.createElement("button")
    item.type = "button"
    item.className = `history-item history-${entry.type}`
    item.innerHTML = `<span class="history-ic">${iconSvg(entry.type === "dir" ? "folder" : "file-text", 15)}</span><span>${escapeHtml(dirName(entry.path))}</span>`
    item.title = entry.path
    item.addEventListener("click", () => { historyDropdown.hidden = true; navigateTo(entry) })
    historyDropdown.appendChild(item)
    shown += 1
  }
  const clear = document.createElement("button")
  clear.type = "button"
  clear.className = "history-clear"
  clear.textContent = "清空历史"
  clear.addEventListener("click", (event) => {
    event.stopPropagation()
    state.history = [state.history[state.historyIndex] || { type: "dir", path: state.dir }]
    state.historyIndex = 0
    updateNavButtons()
    renderHistory()
  })
  historyDropdown.appendChild(clear)
}

function toggleHistory() {
  if (historyDropdown.hidden) renderHistory()
  historyDropdown.hidden = !historyDropdown.hidden
}

elements.nav_history.addEventListener("click", toggleHistory)
document.addEventListener("click", (event) => {
  if (!historyDropdown.hidden && !historyDropdown.contains(event.target) && event.target !== elements.nav_history) {
    historyDropdown.hidden = true
  }
})

// ---------- theme toggle ----------

function applyTheme(dark) {
  // A single authoritative attribute. The CSS prefers-color-scheme fallback
  // is gated on `body:not([data-ds-theme])`, so setting this value always
  // takes effect regardless of the OS theme.
  document.body.setAttribute("data-ds-theme", dark ? "dark" : "light")
  if (dark) document.body.removeAttribute("data-ds-dark-theme")
  try { localStorage.setItem("dvv-theme", dark ? "dark" : "light") } catch { /* storage unavailable */ }
  elements.theme_toggle.innerHTML = iconSvg(dark ? "sun" : "moon", 17)
}

function initTheme() {
  // Host wins (DSH dark attribute), then the manual choice, then the OS.
  // A `?theme=` seed comes from the sidebar launcher (the host browser page
  // opened us), and live flips arrive via postMessage — see below.
  const hostDark = document.body.getAttribute("data-ds-dark-theme") === "true"
  const seeded = (() => { try { return new URLSearchParams(window.location.search).get("theme") } catch { return null } })()
  let dark = false
  const stored = (() => { try { return localStorage.getItem("dvv-theme") } catch { return null } })()
  if (hostDark) dark = true
  else if (seeded === "dark") dark = true
  else if (seeded === "light") dark = false
  else if (stored === "dark") dark = true
  else if (stored === "light") dark = false
  else dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
  applyTheme(dark)
}

elements.theme_toggle.addEventListener("click", () => {
  applyTheme(document.body.getAttribute("data-ds-theme") !== "dark")
})

// Settings gear icon (strokes inherit currentColor; theme-agnostic).
elements.settings_toggle.innerHTML = iconSvg("settings", 17)

// The DSH host may flip its own dark-theme attribute at any time (its UI
// toggle, OS preference change, theme plugin). Follow it so the review page
// never disagrees with the surrounding app.
new MutationObserver(() => {
  const hostDark = document.body.getAttribute("data-ds-dark-theme") === "true"
  const mine = document.body.getAttribute("data-ds-theme")
  if ((hostDark && mine !== "dark") || (!hostDark && mine !== "light")) applyTheme(hostDark)
}).observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] })

// Live theme flips pushed by the sidebar launcher (host browser page). The
// review page is a separate origin, so the host cannot set attributes on us —
// it seeds `?theme=` on open and pushes later changes here.
window.addEventListener("message", (event) => {
  const message = event.data
  if (!message || message.source !== "dsh-document-review" || message.type !== "theme") return
  applyTheme(Boolean(message.dark))
})

// ---------- settings modal (全局设置 / 当前工作区设置) ----------

const settingsModal = document.querySelector("#settings-modal")
const settingsForm = document.querySelector("#settings-form")
const settingsError = document.querySelector("#settings-error")
const settingsScope = document.querySelector("#settings-scope")
const settingsTabs = document.querySelectorAll(".settings-tab")
let settingsLevel = "global"
let settingsRoot = ""

// Order matches the form fields, so resetting can restore each input.
const SETTINGS_FIELDS = [
  "preferredPort", "maxPortTries", "idleTimeoutMinutes", "openBrowserOnStart",
  "indexMaxRoots", "indexMaxEntries", "indexScanCooldownMs", "indexIgnore",
  "showHiddenFiles",
]

function fillSettingsForm(config) {
  for (const name of SETTINGS_FIELDS) {
    const input = settingsForm.elements[name]
    if (!input) continue
    const value = config[name]
    if (input.type === "checkbox") input.checked = Boolean(value)
    else if (name === "indexIgnore") input.value = Array.isArray(value) ? value.join("\n") : ""
    else input.value = value === undefined ? "" : String(value)
  }
}

async function openSettings() {
  settingsError.hidden = true
  try {
    const data = await api("/api/config")
    settingsRoot = data.root || ""
    settingsScope.textContent = `当前工作区：${settingsRoot || "（未指定）"}`
    // Show the effective snapshot; global tab edits the global layer, the
    // workspace tab edits this root's own overrides.
    fillSettingsForm(data.effective)
    state.showHidden = Boolean(data.effective?.showHiddenFiles)
    settingsModal.hidden = false
    document.querySelector(".settings-tab[data-level='global']").classList.add("active")
    document.querySelector(".settings-tab[data-level='workspace']").classList.remove("active")
    settingsLevel = "global"
  } catch (error) {
    settingsError.textContent = `读取配置失败：${error.message}`
    settingsError.hidden = false
  }
}

function closeSettings() {
  settingsModal.hidden = true
  settingsError.hidden = true
}

function readSettingsForm() {
  const config = {}
  for (const name of SETTINGS_FIELDS) {
    const input = settingsForm.elements[name]
    if (!input) continue
    if (input.type === "checkbox") {
      config[name] = input.checked
    } else if (name === "indexIgnore") {
      config[name] = input.value.split("\n").map((s) => s.trim()).filter(Boolean)
    } else if (input.value !== "") {
      config[name] = Number(input.value)
    }
  }
  return config
}

async function saveSettings() {
  settingsError.hidden = true
  const config = readSettingsForm()
  try {
    const path = settingsLevel === "workspace" ? "/api/config/workspace" : "/api/config/global"
    const data = await api(path, { method: "POST", body: JSON.stringify({ config }) })
    // After saving, reflect the merged result back into the form.
    fillSettingsForm(data.effective || config)
    // The server-side singleton may have changed; refresh the stat dot.
    setConnected(true)
    // Hidden-file visibility is read live by the file list: re-render.
    state.showHidden = Boolean(data.effective?.showHiddenFiles)
    if (!elements.file_browser.hidden) renderFileList()
  } catch (error) {
    settingsError.textContent = `保存失败：${error.message}`
    settingsError.hidden = false
  }
}

elements.settings_toggle.addEventListener("click", openSettings)
document.querySelector("#close-settings").addEventListener("click", closeSettings)
document.querySelector(".modal-backdrop").addEventListener("click", closeSettings)
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !settingsModal.hidden) closeSettings()
})
settingsTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    settingsTabs.forEach((t) => t.classList.remove("active"))
    tab.classList.add("active")
    settingsLevel = tab.dataset.level
    const label = settingsLevel === "workspace" ? "当前工作区" : "全局"
    settingsScope.textContent = settingsLevel === "workspace"
      ? `当前工作区：${settingsRoot || "（未指定）"}`
      : "全局设置对所有工作区生效"
    if (settingsLevel === "workspace" && !settingsRoot) {
      settingsScope.textContent = "当前工作区：未打开目录，工作区设置将保存在下次打开的根目录上"
    }
  })
})
settingsForm.addEventListener("submit", (event) => {
  event.preventDefault()
  void saveSettings()
})
document.querySelector("#reset-settings").addEventListener("click", async () => {
  // Empty patch clears the active level's overrides; the server falls back to
  // defaults (plus the entry-config base), then we re-render the form.
  settingsError.hidden = true
  try {
    const path = settingsLevel === "workspace" ? "/api/config/workspace" : "/api/config/global"
    const data = await api(path, { method: "POST", body: JSON.stringify({ config: {} }) })
    fillSettingsForm(data.effective || {})
    setConnected(true)
    state.showHidden = Boolean(data.effective?.showHiddenFiles)
    if (!elements.file_browser.hidden) renderFileList()
  } catch (error) {
    settingsError.textContent = `恢复默认失败：${error.message}`
    settingsError.hidden = false
  }
})

// ---------- heartbeat: keep the singleton server alive ----------

setInterval(async () => {
  try {
    const response = await fetch("/api/health", { cache: "no-store" })
    const ok = response.ok && (await response.json()).ok
    setConnected(Boolean(ok))
  } catch { setConnected(false) }
}, 20000)

function setConnected(connected) {
  state.connected = connected
  elements.status_dot.classList.toggle("offline", !connected)
  elements.status_dot.title = connected ? "审阅服务正常" : "审阅服务已关闭 — 刷新页面可重新开启"
}

// ---------- keyboard gestures ----------

// In the directory list, track the focused row index for Arrow/Enter keys.
let focusedRowIndex = -1

function refocusRow() {
  const rows = elements.file_list.querySelectorAll(".file-row")
  if (rows.length === 0) { focusedRowIndex = -1; return }
  focusedRowIndex = Math.max(0, Math.min(focusedRowIndex, rows.length - 1))
  rows.forEach((row, i) => row.classList.toggle("focused", i === focusedRowIndex))
  rows[focusedRowIndex]?.scrollIntoView({ block: "nearest" })
}

function activateRow() {
  const rows = elements.file_list.querySelectorAll(".file-row")
  let index = focusedRowIndex
  // Fall back to the row the mouse/focus is on (e.g. after clicking a row).
  if (index < 0 && document.activeElement?.classList?.contains("file-row")) {
    index = [...rows].indexOf(document.activeElement)
  }
  const row = rows[index]
  if (!row) return
  const path = row.dataset.path
  if (row.classList.contains("dir")) openDirectory(path)
  else openDocument(path)
}

window.addEventListener("keydown", (event) => {
  const tag = (event.target.tagName || "").toLowerCase()
  const typing = tag === "input" || tag === "textarea" || tag === "select"

  // Alt history/composer shortcuts work independent of typing target.
  if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); goBack(); return }
  if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); goForward(); return }
  if (event.altKey && event.key === "ArrowUp") { event.preventDefault(); elements.nav_up.click(); return }

  // If focus is in a text field, let normal editing happen (except Esc).
  if (typing) {
    if (event.key === "Escape") { closeComposer(); return }
    return
  }

  switch (event.key) {
    case "Escape":
      if (!elements.composer.hidden) closeComposer()
      if (!historyDropdown.hidden) historyDropdown.hidden = true
      elements.selection_toolbar.hidden = true
      break
    case "ArrowDown":
      if (!elements.file_browser.hidden) { event.preventDefault(); focusedRowIndex = focusedRowIndex < 0 ? 0 : focusedRowIndex + 1; refocusRow() }
      break
    case "ArrowUp":
      if (!elements.file_browser.hidden) { event.preventDefault(); focusedRowIndex = focusedRowIndex < 0 ? 0 : focusedRowIndex - 1; refocusRow() }
      break
    case "Enter":
      // Activate whenever a row is highlighted (Arrow keys) or focused
      // (clicked row), not only when the focus is on <body>.
      if (!elements.file_browser.hidden && (focusedRowIndex >= 0 || document.activeElement?.classList?.contains("file-row"))) {
        event.preventDefault(); activateRow()
      }
      break
    case "Backspace":
      if (!elements.file_browser.hidden) { event.preventDefault(); elements.nav_up.click() }
      break
  }
})

// ---------- boot ----------

async function start() {
  setConnected(true)
  mountIcons() // static toolbar icons, then applyTheme() re-fills the toggle
  initTheme()
  try {
    // Seed the hidden-file visibility from the effective config before the
    // first directory renders.
    try {
      const cfg = await api("/api/config")
      state.showHidden = Boolean(cfg.effective?.showHiddenFiles)
    } catch { /* defaults apply */ }
    const health = await api("/api/health")
    state.root = health.root
    await openDirectory(health.root, { record: false })
    state.history = [{ type: "dir", path: state.dir }]
    state.historyIndex = 0
    updateNavButtons()
  } catch (error) {
    showBrowserError(error.message)
  }
}

start()
