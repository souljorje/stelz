// Camofox imports these checks from the built plugin. They decide when a failed click may have reached the page.
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
