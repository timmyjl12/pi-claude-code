import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverClaudeModelsShared,
  getClaudeStatusShared,
  resetClaudeProbeCaches,
} from "../src/claude-cli.ts";

// A fake `claude` that appends one line per process start to PROBE_LOG, answers `auth status` and
// the stream-json catalog probe, and sleeps long enough that concurrent callers genuinely overlap.
async function fakeClaude(root: string, name: string, behaviour: { loggedIn: boolean; failDiscovery?: boolean }) {
  const log = join(root, `${name}.log`);
  const script = join(root, `${name}.cjs`);
  await writeFile(
    script,
    `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PROBE_LOG, (args[0] === "auth" ? "status" : "discover") + "\\n");
const hold = (fn) => setTimeout(fn, 150);
if (args[0] === "auth") {
  hold(() => console.log(JSON.stringify(${behaviour.loggedIn} ? { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" } : { loggedIn: false })));
} else {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (buffer += chunk));
  process.stdin.on("end", () => {
    if (${behaviour.failDiscovery === true}) { console.error("probe failed"); process.exit(3); }
    const request = buffer.split("\\n").map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).find((event) => event?.type === "control_request");
    hold(() => {
      console.log(JSON.stringify({ type: "control_response", response: { request_id: request.request_id, subtype: "success", response: { models: [{ value: "default", displayName: "Default", description: "d" }] } } }));
    });
  });
}
`,
  );
  const executable = join(root, `${name}.cmd`);
  await writeFile(executable, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const env = { PATH: process.env.PATH, PI_CLAUDE_CODE_COMMAND: executable, PROBE_LOG: log };
  const count = async (kind: "status" | "discover") => {
    try {
      return (await readFile(log, "utf8")).split("\n").filter((line) => line === kind).length;
    } catch {
      return 0;
    }
  };
  return { env, count };
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "claude-probe-"));
  resetClaudeProbeCaches();
  try {
    return await run(root);
  } finally {
    resetClaudeProbeCaches();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

test("a burst of availability checks starts one Claude Code process, then reuses the answer", async () => {
  await withRoot(async (root) => {
    const claude = await fakeClaude(root, "ok", { loggedIn: true });
    const burst = await Promise.all(Array.from({ length: 25 }, () => getClaudeStatusShared(claude.env)));
    assert.ok(burst.every((status) => status.available && status.loggedIn && status.subscription));
    assert.equal(await claude.count("status"), 1, "25 concurrent callers share one process");
    await getClaudeStatusShared(claude.env);
    assert.equal(await claude.count("status"), 1, "a recent logged-in answer is reused");
    resetClaudeProbeCaches();
    await getClaudeStatusShared(claude.env);
    assert.equal(await claude.count("status"), 2, "forgetting the cache probes again");
  });
});

test("a cached failure answers availability checks but never an authoritative request path", async () => {
  await withRoot(async (root) => {
    const claude = await fakeClaude(root, "out", { loggedIn: false });
    assert.equal((await getClaudeStatusShared(claude.env, undefined, { acceptCachedFailure: true })).loggedIn, false);
    assert.equal(await claude.count("status"), 1);
    await getClaudeStatusShared(claude.env, undefined, { acceptCachedFailure: true });
    assert.equal(await claude.count("status"), 1, "availability checks reuse a recent failure");
    await getClaudeStatusShared(claude.env);
    assert.equal(await claude.count("status"), 2, "a request must see a fresh login immediately");
  });
});

test("a caller that aborts stops waiting without cancelling the probe the others share", async () => {
  await withRoot(async (root) => {
    const claude = await fakeClaude(root, "abort", { loggedIn: true });
    const leaving = new AbortController();
    const first = getClaudeStatusShared(claude.env, leaving.signal);
    const firstResult = assert.rejects(first, /left/);
    const second = getClaudeStatusShared(claude.env);
    leaving.abort(new Error("left"));
    await firstResult;
    assert.equal((await second).loggedIn, true);
    assert.equal(await claude.count("status"), 1);
  });
});

test("catalog discovery is shared and cached, and a failure is remembered briefly", async () => {
  await withRoot(async (root) => {
    const good = await fakeClaude(root, "catalog", { loggedIn: true });
    const burst = await Promise.all(Array.from({ length: 10 }, () => discoverClaudeModelsShared(good.env)));
    assert.ok(burst.every((models) => models.length === 1 && models[0]?.value === "default"));
    assert.equal(await good.count("discover"), 1, "ten concurrent refreshes share one catalog process");
    await discoverClaudeModelsShared(good.env);
    assert.equal(await good.count("discover"), 1, "the catalog is reused");

    const bad = await fakeClaude(root, "broken", { loggedIn: true, failDiscovery: true });
    await assert.rejects(discoverClaudeModelsShared(bad.env), /discovery failed/);
    await assert.rejects(discoverClaudeModelsShared(bad.env), /discovery failed/);
    assert.equal(await bad.count("discover"), 1, "a broken installation is not re-probed on every refresh");
  });
});
