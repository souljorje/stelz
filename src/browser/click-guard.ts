// Camofox imports clickWithFallback from the built plugin. These checks prevent repeated input.
const message = (error: unknown) => String((error as Error | undefined)?.message || "");

// Playwright logs "performing click action" once a click attempt sends input.
// After that point the page may have received the click, so a fallback click could repeat it.
export function clickReachedPage(error: unknown) {
  return message(error).includes("performing click action");
}

// The DOM fallback rejects a non-HTML element before it clicks. Any other failure may follow the click.
export function domClickRejected(error: unknown) {
  return message(error).includes("Element is not an HTMLElement");
}

// A conflict without a recovery hint: the caller must observe the page before another action.
export function uncertainClickError(cause: unknown) {
  const error = new Error("The click may have reached the page, so it was not repeated. Read a fresh snapshot before the next action.") as Error & { statusCode: number };
  error.statusCode = 409;
  error.cause = cause;
  return error;
}

type ClickOptions = { timeout: number; force?: boolean };

export async function clickWithFallback({ click, domClick, mouseClick, remainingBudget, forceFirst = false }: {
  click: (options: ClickOptions) => Promise<unknown>;
  domClick: () => Promise<unknown>;
  mouseClick: () => Promise<unknown>;
  remainingBudget: () => number;
  forceFirst?: boolean;
}) {
  const budget = () => {
    const remaining = remainingBudget();
    if (remaining <= 0) throw Object.assign(new Error("Click budget exhausted. Read a fresh snapshot before the next action."), { statusCode: 409 });
    return remaining;
  };
  if (!forceFirst) {
    const timeout = Math.max(1, budget() - 5000);
    try {
      await click({ timeout });
      return;
    } catch (error) {
      // A call log can contain both an earlier obstruction and a later native dispatch.
      if (clickReachedPage(error)) throw uncertainClickError(error);
      if (!/intercepts pointer events|not visible|timeout/i.test(message(error))) throw error;
    }
  }
  const timeout = budget();
  try {
    await click({ timeout, force: true });
    return;
  } catch (error) {
    if (clickReachedPage(error)) throw uncertainClickError(error);
  }
  budget();
  try {
    await domClick();
    return;
  } catch (error) {
    if (!domClickRejected(error)) throw uncertainClickError(error);
  }
  budget();
  try { await mouseClick(); }
  catch (error) { throw uncertainClickError(error); }
}
