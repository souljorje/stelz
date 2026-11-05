import { redact } from "./model.ts";

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(redact(message));
    this.name = "ApiError";
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  timeout?: number;
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = window.setTimeout(abort, options.timeout ?? 12_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const response = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: options.body === undefined ? { Accept: "application/json" } : {
        Accept: "application/json", "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null) as T | { error?: unknown } | null;
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error : `The service returned HTTP ${response.status}.`;
      throw new ApiError(response.status, message);
    }
    if (body === null) throw new ApiError(502, "The service returned an unreadable response.");
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (options.signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    throw new ApiError(0, "The local service did not respond. Refresh the connection before making changes.");
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function takeSessionToken(location: Pick<Location, "hash" | "pathname" | "search">, history: Pick<History, "replaceState">): string | null {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  // Do not retain a token in the address bar, history, or browser storage.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return token;
}

export function bootstrapSession(): Promise<void> {
  const token = takeSessionToken(window.location, window.history);
  if (!token) return Promise.resolve();
  return request<unknown>("/api/session", { method: "POST", body: { token } })
    .catch((error: unknown) => {
      // A used launch URL can still belong to a browser with a valid session.
      if (error instanceof ApiError && error.status === 401) return request<unknown>("/api/state");
      throw error;
    }).then(() => undefined);
}

export const profilePath = (id: string) => `/api/profiles/${encodeURIComponent(id)}`;
export const errorMessage = (error: unknown) => error instanceof Error ? redact(error.message) : "The request failed. Refresh and try again.";
