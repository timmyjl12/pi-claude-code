import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cachedClaudeProcessCount, closeClaudeProcesses } from "../src/claude-cli.ts";
import { CLAUDE_CODE_MODELS } from "../src/model-catalog.ts";
import { streamClaudeCode } from "../src/stream.ts";
import { launchable } from "./fake-command.ts";

test("hands Pi a tool call for a tool it never declared", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-stream-"));
  const script = join(root, "fake-claude.mjs");
  await writeFile(
    script,
    `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"}));
  process.exit(0);
}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
    console.log(JSON.stringify({type: "control_response", response: {subtype: "success", request_id: frame.request_id, response: {models: []}}}));
    continue;
  }
  if (frame.type !== "user") continue;
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  const content = [{type: "tool_use", id: "tool_fake", name: "mcp__pi__aggregate_rum_events", input: {query: "*"}}];
  const events = [
    {type: "message_start", message: {id: "m_fake", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "tool_use", id: "tool_fake", name: "mcp__pi__aggregate_rum_events", input: {}}},
    {type: "content_block_delta", index: 0, delta: {type: "input_json_delta", partial_json: '{"query":"*"}'}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "tool_use"}, usage},
    {type: "message_stop"}
  ];
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m_fake", role: "assistant", content, stop_reason: "tool_use", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "error_max_turns", is_error: true, usage}));
}
`,
    "utf8",
  );
  const executable = await launchable(script);

  try {
    const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "claude-opus-5-5")!;
    const stream = streamClaudeCode(
      model,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "count errors" }], timestamp: 0 }],
        tools: [{ name: "mcp__datadog__aggregate_rum_events", description: "Aggregate RUM", parameters: { type: "object" } }],
      } as never,
      { env: { PI_CLAUDE_CODE_COMMAND: executable }, timeoutMs: 5_000, cacheRetention: "none" } as never,
    );
    const message = await stream.result();
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    assert.deepEqual(
      message.content.map((block) => (block.type === "toolCall" ? [block.name, block.arguments] : block.type)),
      [["aggregate_rum_events", { query: "*" }]],
    );
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
});

test("a cache-warming replay leaves the session's retained Claude process alone", async () => {
  // Pi's cache warmer replays the last request with `maxTokens: 1` and `disableContinuation: true`. The output cap
  // changes the launch fingerprint, so routing the replay through the session's process slot closed the retained
  // worker, started one for the replay, and made the next real turn start a third.
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-warm-"));
  const script = join(root, "fake-claude.mjs");
  const log = join(root, "starts.log");
  await writeFile(log, "", "utf8");
  await writeFile(
    script,
    `#!/usr/bin/env node
import {appendFileSync} from "node:fs";
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"}));
  process.exit(0);
}
appendFileSync(process.env.START_LOG, "start maxOutput=" + (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? "default") + "\\n");
let queries = 0;
for await (const line of readline.createInterface({input: process.stdin, crlfDelay: Infinity})) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
    console.log(JSON.stringify({type: "control_response", response: {subtype: "success", request_id: frame.request_id, response: {models: []}}}));
    continue;
  }
  if (frame.type !== "user") continue;
  if (frame.shouldQuery === false) { console.log(JSON.stringify({type: "result", num_turns: 0})); continue; }
  queries += 1;
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  const content = [{type: "text", text: "reply " + queries}];
  console.log(JSON.stringify({type: "stream_event", event: {type: "message_stop"}}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m" + queries, role: "assistant", content, stop_reason: "end_turn", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage}));
}
`,
    "utf8",
  );
  const executable = await launchable(script);
  const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "claude-opus-5-5")!;
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
  const starts = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
  const send = async (messages: unknown[], extra: Record<string, unknown> = {}) => {
    const message = await streamClaudeCode(
      model,
      { systemPrompt: "system", messages, tools: [] } as never,
      { env: { PI_CLAUDE_CODE_COMMAND: executable, START_LOG: log }, timeoutMs: 5_000, sessionId: "warm-session", ...extra } as never,
    ).result();
    assert.equal(message.stopReason, "stop", message.errorMessage);
    return message;
  };

  try {
    const first = await send([user("one")]);
    const secondTurn = [user("one"), first, user("two")];
    const second = await send(secondTurn);
    assert.deepEqual(await starts(), ["start maxOutput=default"], "turn 2 continues the retained process");

    await send(secondTurn, { maxTokens: 1, disableContinuation: true });
    assert.equal(cachedClaudeProcessCount(), 1, "the session's process is still retained after the replay");

    await send([...secondTurn, second, user("three")]);
    assert.deepEqual(
      await starts(),
      ["start maxOutput=default", "start maxOutput=1"],
      "one extra process for the replay; turn 3 continues the original",
    );
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});