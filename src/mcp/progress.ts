import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

/** Send periodic progress while `work` runs, so that clients can reset their request timeouts. */
export async function withProgress<T>(extra: RequestHandlerExtra<ServerRequest, ServerNotification>, message: string,
  work: Promise<T>, intervalMs = 10_000): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return work;
  let ticks = 0;
  const timer = setInterval(() => {
    if (extra.signal.aborted) return clearInterval(timer);
    // Progress is elapsed seconds. A failed notification must not fail the tool call.
    extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: ++ticks * intervalMs / 1000, message } })
      .catch(() => {});
  }, intervalMs);
  try { return await work; }
  finally { clearInterval(timer); }
}
