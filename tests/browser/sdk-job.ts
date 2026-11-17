// One SDK job, as a script author writes it. tests/browser/smoke.ts runs it with STELZ_HOME set, against a started profile.
// It uses the targets section of the fixture page. It writes no storage, cookies, or marker.
export {};
const [sdkModule, profileId, origin] = process.argv.slice(2);
if (!sdkModule || !profileId || !origin) throw Error("Use: bun tests/browser/sdk-job.ts SDK_MODULE PROFILE_ID FIXTURE_ORIGIN");
const { acquire, start } = await import(sdkModule) as typeof import("../../src/sdk/index.ts");
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }

// A repeated start keeps the browser that runs. The caller compares the browser instance before and after the job.
assert((await start(profileId)).phase === "ready", "A repeated start did not return the status of the ready browser.");
await acquire(profileId, async browser => {
  const page = await browser.open(`${origin}/?profile=sdk-job`);
  await page.click("button", "Mark done");
  await page.expectText("Marked");
}, { label: "sdk-job" });

// The tab of the first job is still open, and a second job continues in it.
// A failed expectation fails the job with a clear message. Control is released again.
const failure = await acquire(profileId, async browser => {
  const tab = (await browser.tabs()).find(tab => tab.url.includes("profile=sdk-job"));
  assert(tab, "The tab of the first job is not open.");
  await browser.page(tab.tabId).expectElement("button", "Never there", { timeoutMs: 1000 });
}, { label: "sdk-job" }).then(() => undefined, error => error as Error);
assert(failure?.message.includes('Expected button "Never there" on the page. It did not appear in'), `The failed expectation has no clear message: ${failure?.message}`);
console.log("SDK job passed.");
