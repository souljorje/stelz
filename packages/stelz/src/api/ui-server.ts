import { createUiApp, createUiSessionState, type UiAppOptions } from "./ui-app.ts";
import { transferLimits } from "../profiles/profile-transfer-types.ts";
export { createUiApp, createUiSessionState, UiHttpError, type UiSessionState } from "./ui-app.ts";

type Options = UiAppOptions & { port?: number };

export function createUiServer(options: Options = {}) {
  const port = options.port ?? 9380;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("The UI port must be between 0 and 65535.");
  const state = options.sessionState ?? createUiSessionState();
  const app = createUiApp({ ...options, sessionState: state, onShutdown: () => {
    // Wait for HTTP responses before closing every keep-alive connection.
    void (async () => {
      while (server.pendingRequests) await Bun.sleep(1);
      await server.stop(true);
      options.onShutdown?.();
    })();
  } });
  const server = Bun.serve({
    hostname: "127.0.0.1", port, idleTimeout: 255, maxRequestBodySize: Math.max(16 * 1024 ** 2, transferLimits().archiveBytes),
    fetch: (request): Response | Promise<Response> => app.fetch(request, { origin: `http://127.0.0.1:${server.port}` }),
  });
  const url = `http://127.0.0.1:${server.port}`;
  return { app, server, url, launchUrl: `${url}/#token=${state.bootstrapToken}`, stop: () => server.stop(true) };
}

export function runUi(args: string[]) {
  let port = 9380, open = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--open" && !open) open = true;
    else if (args[i] === "--port" && /^\d+$/.test(args[i + 1] ?? "")) port = Number(args[++i]);
    else throw Error("Use: stelz ui [--port 1024-65535] [--open]");
  }
  if (port < 1024 || port > 65535) throw Error("The UI port must be between 1024 and 65535.");
  const ui = createUiServer({ port, onShutdown: () => process.exit(0) });
  console.log(`stelz UI: ${ui.launchUrl}\nKeep this process running. Ctrl-C closes the UI server and preserves browsers.`);
  if (open) {
    const command = process.platform === "darwin" ? "open" : "xdg-open";
    if (!Bun.which(command)) console.error(`Open the printed URL in your browser. ${command} is unavailable.`);
    else {
      const child = Bun.spawn([command, ui.launchUrl], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      child.unref();
    }
  }
  const close = () => { ui.stop(); process.exit(0); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return ui;
}
