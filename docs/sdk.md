---
title: "Script SDK"
description: "The stelz/sdk API for Bun scripts: start, acquire, Browser and Page methods, errors, and crash takeover, to read when you write a scripted browser task."
tags: [sdk, scripts, reference]
sources: []
created: 2026-11-15T15:00:00Z
modified: 2026-11-15T15:00:00Z
---

# Script SDK

- `stelz/sdk` controls profiles from a Bun script. It does not use a model.
- It runs the same operations as the [MCP tools](mcp.md), with the same names and the same rules. It calls the same code, not a child `stelz mcp` process.
- A script needs a configured profile. Configuration, proxies, deletion, import, stop, recovery, and forced handoff stay in the [CLI](cli.md) and the UI.

## Run a script

- Use Bun. The SDK does not run on Node.
- Run the script on the machine of the browser service. Select the service directory with `STELZ_HOME`.
- Install the `stelz` package where the script runs, for example with `bun add stelz`. From a checkout, import `src/sdk/index.ts` by its path.

```sh
STELZ_HOME=/path/to/stelz-home APP_URL=https://your-app.example bun daily.ts your-profile
```

- The SDK has no `home` option. `STELZ_HOME` sets the directory when the module loads. The default is `~/.local/share/stelz`.
- The script reads the service files and the prepared runtime in that directory. Run `stelz setup` first.

## Example

This example uses an imagined app. Replace its labels and its success check with the labels of your app.

```ts
import { acquire, start } from "stelz/sdk";

const [profileId, appUrl] = [process.argv[2], process.env.APP_URL];
if (!profileId || !appUrl) throw Error("Use: APP_URL=https://your-app.example bun daily.ts PROFILE_ID");
const reportName = `Daily report ${new Date().toISOString().slice(0, 10)}`;

await start(profileId);
await acquire(profileId, async browser => {
  const page = await browser.open(new URL("/reports", appUrl).href);
  // The profile keeps its saved login. See "Human authentication" if the login expires.
  await page.expectElement("heading", "Reports");
  if ((await page.snapshot()).includes(reportName)) return;
  await page.click("button", "Create report");
  await page.type("textbox", "Report name", reportName);
  await page.click("button", "Save report");
  await page.expectText(reportName);
}, { artifactsDir: new URL("./artifacts", import.meta.url).pathname });
```

- The check for an existing report reduces duplicates. Use a uniqueness rule in the app for a reliable guarantee.
- Do not repeat a failed submission before you check whether it succeeded.
- A scheduler can run the script. The SDK installs no schedule.
- A profile has one controller. Another controller fails to acquire it.

## Start and acquire

| Function | Effect |
| --- | --- |
| `start(profileId, { signal? })` | Starts the browser of the profile, as `stelz start` and `profile_start` do. Returns the same status. A browser that runs stays as it is. |
| `acquire(profileId, work, options?)` | Takes control of a running profile, calls `work(browser)`, and releases control. Returns the result of `work`. |

- `start` can take a while. Pass a `signal` to cancel it.
- A location failure makes `start` throw a `LocationError`. Its `location` property has the same `code` and details that MCP returns.
- `acquire` never starts a browser. A stopped profile fails with a message that names `start()`.
- `acquire` checks the profile before it takes control. The phase must be `ready`. A profile that requires verification must be verified. Otherwise `acquire` fails and `work` does not run.
- `acquire` warns when the profile runs an older runtime (`restartToUpdate`) or has stale or conflicting location evidence. It never restarts the profile.
- `acquire` releases control when `work` ends or fails. It leaves the browser and its tabs open.
- Call `acquire` once for each profile. Several profiles in one script use several calls.

| Option | Effect |
| --- | --- |
| `label` | The controller label that the UI and `profile_status` show. The default is the file name of the script. |
| `artifactsDir` | Opt in. When the script fails, `captureFailure` saves a snapshot and a screenshot in a new folder here. They can contain private page content. |
| `onNotice` | Receives the warnings. The default is `console.warn`. |

## Browser

| Method | Effect |
| --- | --- |
| `tabs()` | Lists the tabs that Stelz manages: `{tabId, url, title?}`. |
| `page(tabId)` | Returns the `Page` of a tab. |
| `open(url)` | Returns the `Page` of the tab with exactly this URL. If none exists, it navigates the blank tab of a new browser. Otherwise it creates a tab. |
| `pause()`, `resume()` | The same operations as `stelz pause`, `stelz resume`, `profile_pause`, and `profile_resume`. The script keeps control. |
| `captureFailure(directory)` | Saves `snapshot.txt` and `page.png` of the last page that the script used. It calls `tab_screenshot`, because a snapshot has no screenshot. |

- `open` can reuse a blank tab that a person opened. It does not reload a tab that already shows the exact URL.

### Human authentication

Pause for a person in the same window. Do not bypass an authentication challenge.

```ts
await browser.pause();
prompt("Sign in to the open window. Then press Enter.");
await browser.resume();
await page.expectElement("heading", "Reports");
```

- A paused profile refuses every action, including a wait. Resume first.
- `resume` can check the IP of the browser before it returns.

## Page

An action names its element with a role and an accessible name, as `tab_snapshot` shows them. Stelz finds the element in a fresh snapshot in the same step. See [Targets](mcp.md#targets).

| Method | Effect |
| --- | --- |
| `navigate(url)` | Goes to a URL. |
| `click(role, name, { nth? })` | Clicks the element. |
| `type(role, name, text, { mode?, pressEnter?, nth? })` | Enters text with the typing semantics of Stelz. It is not Playwright `fill()`. See [Typing](configuration/typing.md). |
| `select(role, name, option, { nth? })` | Chooses an option in a native list. |
| `press(key)` | Presses one key. |
| `scroll(direction, amount = 500)` | Scrolls up, down, left, or right. |
| `snapshot({ scope?, contains?, diff? })` | Returns the page as text. See below. |
| `expectElement(role, name, { timeoutMs? })` | Waits until the element is on the page. |
| `expectText(text, { timeoutMs? })` | Waits until a line of the page contains the text. The match is not case-sensitive. |
| `evaluate(expression, { timeoutMs? })` | Runs JavaScript in the page and returns its result. See below. |

- An action does not return the page. Actions use `observe: "none"`. Check the result with `expectElement`, `expectText`, or `snapshot`.
- When no element matches, or more than one element matches and `nth` is missing, the action fails before it reaches the page. `nth` counts from 0, in page order.
- `expectElement` and `expectText` call `tab_wait`. The default `timeoutMs` is 10000. The maximum is 60000. See [Wait](mcp.md#wait).
- An expectation fails with a clear message when the element or the text does not appear. The message also covers a pause or a release during the wait.
- `snapshot` returns the whole text of the page, without collapsed items. It reads a long page in windows of 80000 characters and joins them. It does not fail on truncation. `scope`, `contains`, and `diff` work as in [Snapshots](mcp.md#snapshots).
- `evaluate` works only on a profile that a person set with **Allow scripts**. See [Scripts](mcp.md#scripts). The SDK cannot change that setting. Turn it on before the script starts.

## Queue and errors

- One `acquire` call has one queue. The SDK runs one operation at a time, in call order. An action and its check never overlap.
- When an operation fails, the SDK cancels the operations that wait behind it. Later calls fail with the same error. `acquire` releases control and throws that error.
- A failed `expect*` or action ends the job, even if `work` catches it. To branch on the page, use `snapshot({ contains })` or `tabs()`.
- The SDK never retries an action. A timeout can leave the outcome unknown. Check the page before you repeat the work.
- An error message hides the control handle and every text that the script typed. It shows `[redacted]` instead.
- If both `work` and the release fail, `acquire` throws an `AggregateError` with both errors.
- Use the `Browser` only inside `work`. After `acquire` returns, the session ends and every call fails.

## Crash and takeover

- The SDK installs no signal handlers. Handling `SIGINT` and `SIGTERM` is the choice of the script.
- If the script dies before it releases control, the browser and its pages stay open.
- The service sees that the process of the controller is dead. The next `acquire` takes over from it. See [Control handles](mcp.md#control-handles).
- If an action was still running when the script died, the service waits until it ends. `acquire` fails until then. Try again after a short time.
- A person can release control by force with `stelz release ID`. See [CLI](cli.md).
