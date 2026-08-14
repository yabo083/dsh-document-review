/**
 * Minimal structural type for the DSH host web-server route host, so a
 * third-party plugin can register HTTP routes without importing the
 * host-webserver package (which carries heavy host-side context merges).
 *
 * The real service is `ctx.webServer` (older deployments: `ctx.httpServer`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface WebRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

export interface WebRouteHost {
  register(route: WebRoute): () => void;
}
