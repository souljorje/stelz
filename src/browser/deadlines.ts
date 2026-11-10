// Time limits for browser actions. Each layer waits longer than the layer that it calls,
// so the innermost limit reports first and no caller abandons work that is still within its limit.

/** Clicks, navigation, scrolls, snapshots, screenshots, and tab changes in the upstream Camofox route. */
export const ACTION_LIMIT_MS = 30_000;
/** One camofox_type call. Paced keyboard typing takes about 100 ms for each character. */
export const TYPING_LIMIT_MS = 180_000;
// The service deadline also covers an IP check before the action. A late action blocks its browser lifetime.
const SERVICE_MARGIN_MS = 30_000;
// A caller waits for the service deadline plus the time to receive the reply.
const REPLY_MARGIN_MS = 15_000;

export const actionLimit = (tool: string) => tool === "camofox_type" ? TYPING_LIMIT_MS : ACTION_LIMIT_MS;
/** The service deadline for a control operation, such as an IP recheck. */
export const SERVICE_DEADLINE_MS = ACTION_LIMIT_MS + SERVICE_MARGIN_MS;
/** The service deadline for one browser tool call. */
export const serviceDeadline = (tool: string) => actionLimit(tool) + SERVICE_MARGIN_MS;
/** How long a caller of the service waits for one browser tool call. */
export const replyTimeout = (tool: string) => serviceDeadline(tool) + REPLY_MARGIN_MS;
