// Time limits for browser actions. Each layer waits longer than the layer that it calls,
// so the innermost limit reports first and no caller abandons work that is still within its limit.
// The catalog gives each tool a limit from its call arguments. The two layers above add their margins to that limit.

/** Clicks, navigation, scrolls, snapshots, screenshots, and tab changes in the upstream Camofox route. */
export const ACTION_LIMIT_MS = 30_000;
/** One tab_type call. Paced keyboard typing takes about 100 ms for each character. */
export const TYPING_LIMIT_MS = 180_000;
/** The upstream wait of tab_wait ends at its timeout argument. The schema accepts at most this value. */
export const WAIT_DEFAULT_MS = 10_000;
export const WAIT_MAX_MS = 60_000;
/** The pause between two snapshots of a tab_wait that has a target or a text. */
export const WAIT_POLL_MS = 300;
/**
 * The time limit of one snapshot read after an action (`observe`). That read has its own timer, apart from the service deadline of the action.
 * A late read then never turns a finished action into an error. It is also the allowance for the last poll of a tab_wait, inside the service deadline.
 * A snapshot takes well under a second on a normal page. The client examples allow 240 seconds for one call, and a tab_type call
 * with its read must fit: 180 + 15 seconds for the limit of the call, plus the margins below.
 */
export const OBSERVE_LIMIT_MS = 15_000;
/** The upstream deadline of tab_evaluate is its timeoutMs argument. The schema accepts at most this value. */
export const EVALUATE_DEFAULT_MS = 30_000;
export const EVALUATE_MIN_MS = 1_000;
export const EVALUATE_MAX_MS = 120_000;
// The service deadline also covers an IP check before the action. A late action blocks its browser lifetime.
const SERVICE_MARGIN_MS = 30_000;
// A caller waits for the service deadline plus the time to receive the reply.
const REPLY_MARGIN_MS = 15_000;

// A bad value never lengthens the limit. The argument check rejects it before the call.
function argumentLimit(value: unknown, fallback: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback;
}
/** How long a tab_wait waits for its page, target, or text. */
export const waitDuration = (args: Record<string, unknown>) => argumentLimit(args.timeout, WAIT_DEFAULT_MS, WAIT_MAX_MS);
/** A wait with a target or a text polls snapshots. A poll can start just before the timeout. */
export const waitLimit = (args: Record<string, unknown>) => waitDuration(args) + (args.target !== undefined || args.contains !== undefined ? OBSERVE_LIMIT_MS : 0);
/**
 * The limit of an action that reads the page afterward, unless the call turns that off with `observe: "none"`. A caller waits this long.
 * The service deadline covers the action alone (`actionDeadline` in the catalog), and the read follows with its own timer.
 */
export const observedLimit = (limit: number) => (args: Record<string, unknown>) => limit + (args.observe === "none" ? 0 : OBSERVE_LIMIT_MS);
export const evaluateLimit = (args: Record<string, unknown>) => argumentLimit(args.timeoutMs, EVALUATE_DEFAULT_MS, EVALUATE_MAX_MS);

/** The service deadline for a control operation, such as an IP recheck. */
export const SERVICE_DEADLINE_MS = ACTION_LIMIT_MS + SERVICE_MARGIN_MS;
/** The service deadline for one browser tool call. `limit` is the catalog deadline of that call. */
export const serviceDeadline = (limit: number) => limit + SERVICE_MARGIN_MS;
/** How long a caller of the service waits for one browser tool call. */
export const replyTimeout = (limit: number) => serviceDeadline(limit) + REPLY_MARGIN_MS;
