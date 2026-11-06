// Browser e2e: the clients `make e2e` generated with the packed CLI, bundled with input/browser-smoke.ts and run in
// headless Chromium, Firefox and WebKit (Playwright) against a same-origin mock API. Node.js and Bun pass the same
// checks in scripts/e2e.ts; this is where the browser engines prove the lossless JSON features, AbortSignal
// timeouts and streamed bodies. Writes output/browser-report.json; exits 1 when any check fails in any browser.
// Run after scripts/e2e.ts (it needs the packed CLI in tmp/e2e/consumer); `make e2e` runs both.
// VERIFIED: it found WebKit 27.2 rejecting an aborted fetch with AbortError instead of the signal's reason (see fetch-send.ts abortReason).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, firefox, webkit, type BrowserType } from "playwright";

const repositoryRoot = join(import.meta.dir, "..");
const outputDirectory = join(repositoryRoot, "output");
const cli = join(repositoryRoot, "tmp", "e2e", "consumer", "node_modules", ".bin", "open-api-gen");

function log(level: string, message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${level} ${message}\n`);
}

if (!existsSync(cli) || !existsSync(join(outputDirectory, "clients", "petstore-app")) || !existsSync(join(outputDirectory, "clients", "webhooks"))) {
  log("ERROR", "run scripts/e2e.ts first: it packs the CLI and generates the clients this test bundles");
  process.exit(1);
}
// The streaming client comes from the same packed CLI.
execFileSync("node", [cli, join(repositoryRoot, "test", "fixtures", "features-3.2.yaml"), "-o", join(outputDirectory, "clients", "features-3-2"), "--naming", "camelCase"], { cwd: repositoryRoot, stdio: "pipe" });

const build = await Bun.build({ entrypoints: [join(repositoryRoot, "input", "browser-smoke.ts")], target: "browser", outdir: join(outputDirectory, "browser") });
if (!build.success) {
  log("ERROR", `bundling input/browser-smoke.ts failed: ${build.logs.map(String).join("; ")}`);
  process.exit(1);
}
const bundlePath = build.outputs[0]!.path;
const page = '<!doctype html><html><head><meta charset="utf-8"><title>open-api-gen browser e2e</title></head><body><script type="module" src="/app.js"></script></body></html>';

const busyAnswersByToken = new Map<string, number>();
const json = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "application/json" } });
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/app.js") {
      return new Response(Bun.file(bundlePath), { headers: { "content-type": "text/javascript" } });
    }
    if (url.pathname === "/api/store/order/9007199254740993") {
      return json('{"id":9007199254740993,"petId":12,"quantity":2,"shipDate":"2026-03-04T05:06:07.000Z","status":"placed","complete":false}');
    }
    if (url.pathname === "/api/store/order/1") {
      return json('{"id":"one","quantity":2}');
    }
    if (url.pathname === "/api/store/order/5") {
      await Bun.sleep(500);
      return json('{"id":5}');
    }
    if (url.pathname === "/api/store/order" && request.method === "POST") {
      // Echo the body text unchanged: the browser must have written the int64 exactly for the check to pass.
      return json(await request.text());
    }
    if (url.pathname === "/api/store/inventory") {
      if (request.headers.get("api_key") !== "browser-key") {
        return json('{"message":"missing api_key"}', 401);
      }
      const token = request.headers.get("x-busy-token") ?? "";
      const answered = busyAnswersByToken.get(token) ?? 0;
      busyAnswersByToken.set(token, answered + 1);
      if (answered < 2) {
        return new Response(null, { status: 503, headers: { "retry-after": "0" } });
      }
      return json('{"available":3,"sold":1}');
    }
    if (url.pathname === "/api/items/stream") {
      return new Response('{"id":"a","updated_at":"2026-01-02T03:04:05.000Z"}\n{"id":"b"}\n', { headers: { "content-type": "application/jsonl" } });
    }
    return json('{"message":"not found"}', 404);
  },
});

type SmokeResult = { name: string; ok: boolean; detail?: string };
const report: Record<string, { version: string; results: SmokeResult[]; pageErrors: string[] }> = {};
const browserTypes: [string, BrowserType][] = [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]];
let failed = 0;
try {
  for (const [browserName, browserType] of browserTypes) {
    const browser = await browserType.launch();
    try {
      const browserPage = await browser.newPage();
      const pageErrors: string[] = [];
      browserPage.on("pageerror", (error) => pageErrors.push(error.message));
      await browserPage.goto(`http://localhost:${server.port}/`);
      await browserPage.waitForFunction(() => (globalThis as unknown as { smokeDone?: boolean }).smokeDone === true, undefined, { timeout: 30_000 }).catch(() => undefined);
      const results = await browserPage.evaluate(() => (globalThis as unknown as { smokeResults?: SmokeResult[] }).smokeResults ?? []);
      report[browserName] = { version: browser.version(), results, pageErrors };
      if (results.length === 0) {
        failed++;
        log("ERROR", `${browserName} ${browser.version()}: the page reported no results; page errors: ${pageErrors.join("; ") || "none"}`);
      }
      for (const result of results) {
        if (result.ok) {
          process.stdout.write(`ok - ${browserName}: ${result.name}\n`);
        } else {
          failed++;
          process.stdout.write(`not ok - ${browserName}: ${result.name}${result.detail === undefined ? "" : ` (${result.detail})`}\n`);
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.stop(true);
}
await Bun.write(join(outputDirectory, "browser-report.json"), `${JSON.stringify(report, null, 2)}\n`);
const versions = Object.entries(report).map(([browserName, entry]) => `${browserName} ${entry.version}`).join(", ");
if (failed > 0) {
  log("ERROR", `browser e2e: ${failed} failed checks (${versions}); details in output/browser-report.json`);
  process.exit(1);
}
log("INFO", `browser e2e passed in ${versions}; report in output/browser-report.json`);
