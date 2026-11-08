import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import test from "node:test";
import { AsyncQueue, FrameHistoryDigest } from "../src/claude-cli.ts";
import type { NativeFrame } from "../src/native-types.ts";

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function legacyFrameHistoryHash(frames: NativeFrame[]): string {
  const value = frames.map((frame) => ({ type: frame.type, message: frame.message }));
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const userFrame = (text: string): NativeFrame => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
});

const assistantFrame = (text: string): NativeFrame => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

test("incremental frame digests preserve canonical parity without rereading the prefix", () => {
  let prefixMessageReads = 0;
  const first = new Proxy(userFrame("first"), {
    get(target, property, receiver) {
      if (property === "message") prefixMessageReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const frames = [first, assistantFrame("reply"), userFrame("next")];
  const history = new FrameHistoryDigest();
  assert.equal(history.hash(frames, 2), legacyFrameHistoryHash(frames.slice(0, 2)));

  const response = assistantFrame("next reply");
  const expected = legacyFrameHistoryHash([...frames, response]);
  prefixMessageReads = 0;
  const appended = history.append(frames, 2, [frames[2]!, response]);
  assert.equal(appended, expected);
  assert.equal(prefixMessageReads, 0);
  assert.equal(history.hash(frames), legacyFrameHistoryHash(frames));

  frames.push(assistantFrame("another reply"));
  assert.equal(history.hash(frames), legacyFrameHistoryHash(frames));
  frames[frames.length - 1] = userFrame("replacement tail");
  assert.equal(history.hash(frames), legacyFrameHistoryHash(frames));

  frames[0]!.message.content[0] = { type: "text", text: "edited earlier request" };
  assert.equal(new FrameHistoryDigest().hash(frames), legacyFrameHistoryHash(frames));
});

test("delivers queued events in order before end", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.push(2);
  assert.equal(await queue.next(undefined, 100), 1);
  assert.equal(await queue.next(undefined, 100), 2);
  queue.end();
  assert.equal(await queue.next(undefined, 100), undefined);
});

test("shares one watchdog and abort listener across 5000 pending event deliveries", async () => {
  const queue = new AsyncQueue<number>();
  const controller = new AbortController();
  const signal = controller.signal;
  const originalSetTimeout = globalThis.setTimeout;
  let timerCreations = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timerCreations += 1;
    return originalSetTimeout(...args);
  }) as typeof setTimeout;

  try {
    for (let value = 0; value < 5_000; value++) {
      const pending = queue.next(signal, 10_000);
      queue.push(value);
      assert.equal(await pending, value);
    }
    assert.equal(timerCreations, 1);
    assert.equal(getEventListeners(signal, "abort").length, 1);
    queue.disarm();
    assert.equal(getEventListeners(signal, "abort").length, 0);
  } finally {
    queue.end();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("refreshes the idle watchdog for each event and cleans up after timeout", async () => {
  const queue = new AsyncQueue<number>();
  for (let value = 0; value < 3; value++) {
    const pending = queue.next(undefined, 60);
    await delay(30);
    queue.push(value);
    assert.equal(await pending, value);
  }
  await assert.rejects(queue.next(undefined, 60), /Claude Code stream timed out/);
  queue.end();
  assert.equal(await queue.next(undefined, 60), undefined);
});

test("abort rejects the pending event and removes the shared listener", async () => {
  const queue = new AsyncQueue<number>();
  const controller = new AbortController();
  const reason = new Error("stop this turn");
  const pending = queue.next(controller.signal, 10_000);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);

  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  queue.end();
});
