import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cachedClaudeProcessCount,
  closeClaudeProcesses,
  runClaudeRequest,
  type RunClaudeInput,
} from "../src/claude-cli.ts";
import type { NativeFrame } from "../src/native-types.ts";

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const userFrame = (text: string, shouldQuery?: false): NativeFrame => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
  shouldQuery,
});

async function makeExecutable(root: string, name: string): Promise<string> {
  const script = join(root, `${name}.mjs`);
  await writeFile(
    script,
    `#!/usr/bin/env node
import {appendFileSync} from "node:fs";
import readline from "node:readline";
const log = event => appendFileSync(process.env.PROCESS_LOG, event + "\\n");
if (process.argv.includes("auth") && process.argv.includes("status")) {
  log("auth-start:" + process.env.PROFILE);
  await new Promise(resolve => setTimeout(resolve, 300));
  log("auth-end:" + process.env.PROFILE);
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"}));
  process.exit(0);
}
log("worker-start:" + process.pid + ":" + process.env.PROFILE);
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
let queryCount = 0;
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({type: "result", num_turns: 0}));
    continue;
  }
  queryCount += 1;
  const id = process.env.PROFILE + "-" + queryCount;
  const usage = {input_tokens: 1, output_tokens: 1};
  console.log(JSON.stringify({type: "stream_event", event: {type: "message_stop"}}));
  console.log(JSON.stringify({type: "assistant", message: {id, role: "assistant", content: [{type: "text", text: id}], stop_reason: "end_turn", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage}));
}
`,
    "utf8",
  );
  const executable = process.platform === "win32" ? join(root, `${name}.cmd`) : script;
  if (executable !== script) await writeFile(executable, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

async function readLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function waitForLog(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await readLog(path)).includes(expected)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for log entry: ${expected}`);
}

test("process reservations preserve continuation without serializing cold starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-reservations-"));
  const processLog = join(root, "processes.log");
  const commands = new Map<string, string>();
  for (const profile of ["A", "B", "C", "D", "E"]) commands.set(profile, await makeExecutable(root, `claude-${profile}`));
  await writeFile(processLog, "", "utf8");

  const request = (profile: string, sessionId: string, frames: NativeFrame[]): RunClaudeInput => ({
    model: "sonnet",
    cwd: root,
    frames,
    systemPrompt: "system",
    manifest: [],
    extraBody: {},
    env: {
      PATH: process.env.PATH,
      PI_CLAUDE_CODE_COMMAND: commands.get(profile),
      PROCESS_LOG: processLog,
      PROFILE: profile,
    },
    sessionId,
    timeoutMs: 5_000,
  });

  try {
    const [left, right] = await Promise.all([
      runClaudeRequest(request("A", "cold-A", [userFrame("left")])),
      runClaudeRequest(request("B", "cold-B", [userFrame("right")])),
    ]);
    assert.equal(left.message.id, "A-1");
    assert.equal(right.message.id, "B-1");
    const coldLog = await readLog(processLog);
    const starts = [coldLog.indexOf("auth-start:A"), coldLog.indexOf("auth-start:B")];
    const ends = [coldLog.indexOf("auth-end:A"), coldLog.indexOf("auth-end:B")];
    assert.ok(Math.min(...starts) >= 0 && Math.min(...ends) >= 0, coldLog);
    assert.ok(Math.max(...starts) < Math.min(...ends), `authentication was serialized:\n${coldLog}`);
    await closeClaudeProcesses();

    const firstPromise = runClaudeRequest(request("C", "shared-cold", [userFrame("one")]));
    await waitForLog(processLog, "auth-start:C");
    const secondPromise = runClaudeRequest(request("C", "shared-cold", [userFrame("concurrent")]));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.message.id, "C-1");
    assert.equal(second.message.id, "C-1");
    assert.equal(cachedClaudeProcessCount(), 1);

    const continued = await runClaudeRequest(
      request("C", "shared-cold", [
        userFrame("one", false),
        { type: "assistant", message: { role: "assistant", content: first.message.content } },
        userFrame("follow up"),
      ]),
    );
    assert.equal(continued.message.id, "C-2");
    assert.equal((await readLog(processLog)).split("worker-start:").length - 1, 4);
    await closeClaudeProcesses();

    const pendingClose = runClaudeRequest(request("E", "pending-close", [userFrame("cleanup")]));
    const pendingCloseAssertion = assert.rejects(pendingClose);
    await waitForLog(processLog, "auth-start:E");
    await closeClaudeProcesses("pending-close");
    assert.equal(cachedClaudeProcessCount(), 0);
    await pendingCloseAssertion;

    await assert.rejects(
      runClaudeRequest({
        ...request("D", "failed-then-warm", [userFrame("failure")]),
        env: { PATH: process.env.PATH, PI_CLAUDE_CODE_COMMAND: join(root, "missing-claude.exe") },
      }),
      /Claude Code is not installed/,
    );
    const recovered = await runClaudeRequest(request("D", "failed-then-warm", [userFrame("one")]));
    const recoveredContinuation = await runClaudeRequest(
      request("D", "failed-then-warm", [
        userFrame("one", false),
        { type: "assistant", message: { role: "assistant", content: recovered.message.content } },
        userFrame("two"),
      ]),
    );
    assert.equal(recoveredContinuation.message.id, "D-2");
    assert.equal(cachedClaudeProcessCount(), 1);
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
});
