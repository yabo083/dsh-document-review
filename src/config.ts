/**
 * Review plugin configuration — surfaced as a DSH settings panel
 * (`ctx.settings.register` + schemastery schema renders the form).
 */

import z from "@deepseek-ai/schemastery";

/** User-facing configuration for the review singleton and filename index. */
export interface ReviewConfig {
  /** First port to try for the review server. */
  preferredPort: number;
  /** How many consecutive ports to try before giving up. */
  maxPortTries: number;
  /** Idle time (minutes) before the singleton server auto-shuts down. */
  idleTimeoutMinutes: number;
  /** Open the review page in the browser when a session starts. */
  openBrowserOnStart: boolean;
  /** Max index roots remembered (browsed directories). */
  indexMaxRoots: number;
  /** Max indexed entries across all roots. */
  indexMaxEntries: number;
  /** Minimum interval (ms) between full rescans of one root. */
  indexScanCooldownMs: number;
  /** Directory names excluded from indexing / migration. */
  indexIgnore: string[];
}

/** Fallbacks used when the settings service is unavailable. */
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  preferredPort: 15580,
  maxPortTries: 20,
  idleTimeoutMinutes: 30,
  openBrowserOnStart: true,
  indexMaxRoots: 64,
  indexMaxEntries: 60_000,
  indexScanCooldownMs: 30_000,
  indexIgnore: [
    "node_modules", ".git", ".hg", ".svn", ".idea", ".vscode", ".DS_Store",
    "cache", "data", "dist", "build", "out", "target", ".next", ".nuxt",
    ".turbo", ".cache", "__pycache__", ".venv", "venv", ".dsh", "logs",
  ],
};

/** Settings namespace owned by this plugin (lowercase kebab, required). */
export const REVIEW_SETTINGS_NAMESPACE = "document-review";

/** Durable settings schema; the DSH settings panel renders this as a form. */
export const ReviewSettingsSchema = z.object({
  preferredPort: z.number().min(1024).max(65535).default(DEFAULT_REVIEW_CONFIG.preferredPort).description("审阅服务首选端口，被占用时自动 +1 尝试"),
  maxPortTries: z.number().min(1).max(100).default(DEFAULT_REVIEW_CONFIG.maxPortTries).description("端口被占用时最多顺延尝试的次数"),
  idleTimeoutMinutes: z.number().min(1).max(1440).default(DEFAULT_REVIEW_CONFIG.idleTimeoutMinutes).description("无操作多少分钟后自动关闭审阅服务（0 表示不自动关闭）"),
  openBrowserOnStart: z.boolean().default(DEFAULT_REVIEW_CONFIG.openBrowserOnStart).description("启动审阅会话时自动打开浏览器页面"),
  indexMaxRoots: z.number().min(1).max(512).default(DEFAULT_REVIEW_CONFIG.indexMaxRoots).description("文件名索引记住的浏览目录上限（超出后淘汰最久未用）"),
  indexMaxEntries: z.number().min(100).max(1_000_000).default(DEFAULT_REVIEW_CONFIG.indexMaxEntries).description("索引条目总数上限，防止超大目录拖垮内存"),
  indexScanCooldownMs: z.number().min(1_000).max(3_600_000).default(DEFAULT_REVIEW_CONFIG.indexScanCooldownMs).description("同一目录两次全量扫描的最小间隔（毫秒）"),
  indexIgnore: z.array(z.string()).default([...DEFAULT_REVIEW_CONFIG.indexIgnore]).description("索引与迁移时跳过的目录名（每行一个）"),
}).description("文档审阅插件配置");
