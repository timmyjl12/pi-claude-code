import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_MODELS,
  modelFromDiscovery,
  nativeModel,
  supportsDisabledThinking,
  supportsNativeToolChanges,
} from "../src/model-catalog.ts";

test("fallback catalog matches Claude Code's selectable model families", () => {
  assert.deepEqual(
    CLAUDE_CODE_MODELS.map((model) => model.id),
    [
      "default",
      "claude-opus-5-5",
      "claude-fable-5-2",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ],
  );
  assert.equal(nativeModel("default"), "default");
  assert.equal(nativeModel("claude-opus-5-5"), "opus[1m]");
  assert.equal(nativeModel("claude-sonnet-5"), "sonnet");
  assert.equal(supportsNativeToolChanges("default"), true);
  assert.equal(supportsNativeToolChanges("claude-opus-5-5"), true);
  assert.equal(nativeModel("claude-fable-5-2"), "fable");
  assert.equal(nativeModel("fable"), "claude-fable-5-2");
  assert.equal(supportsNativeToolChanges("claude-fable-5-2"), true);
  assert.equal(supportsNativeToolChanges("claude-fable-5-1"), true);
  assert.equal(supportsNativeToolChanges("claude-sonnet-5"), false);
});

test("maps discovered aliases to stable canonical Pi model ids", () => {
  const opus = modelFromDiscovery({
    value: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5.5 with 1M context",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high", "max"],
    supportsAdaptiveThinking: true,
  });
  assert.equal(opus.id, "claude-opus-5-5");
  assert.equal(opus.name, "Claude Opus 5.5");
  assert.equal(opus.contextWindow, 1_000_000);
  assert.deepEqual(opus.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(opus.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });

  const future = modelFromDiscovery({
    value: "future",
    resolvedModel: "claude-future-1",
    displayName: "Future",
    description: "A newly available model",
  });
  assert.equal(future.id, "claude-future-1");
  assert.equal(future.cost.input, 0);
  assert.equal(future.contextWindow, 200_000);

  const suffixed = modelFromDiscovery({
    value: "claude-future-2[1m]",
    displayName: "Future 2",
    description: "A newly available model",
  });
  assert.equal(suffixed.id, "claude-future-2");
  assert.equal(suffixed.contextWindow, 1_000_000);
});

test("a point release missing from Pi's catalog inherits its predecessor's limits", () => {
  // The row Claude Code 2.1.321 reports for Fable 5.2: no "1M context" text and no [1m] suffix.
  const fable = modelFromDiscovery({
    value: "fable",
    resolvedModel: "claude-fable-5-2",
    displayName: "Fable 5.2",
    description: "For your toughest challenges",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsThinkingOff: false,
  });
  assert.equal(fable.id, "claude-fable-5-2");
  assert.equal(fable.name, "Fable 5.2 (Claude Code)");
  assert.equal(fable.contextWindow, 1_000_000);
  assert.equal(fable.maxTokens, 128_000);
  assert.equal(fable.thinkingLevelMap?.off, null);
  // Pricing is not assumed to carry over between releases.
  assert.deepEqual(fable.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(supportsNativeToolChanges("claude-fable-5-2"), true);
  assert.equal(supportsDisabledThinking("claude-fable-5-2"), false);
});

test("Claude Code's supportsThinkingOff overrides the catalog's guess", () => {
  const row = {
    value: "claude-opus-5",
    resolvedModel: "claude-opus-5",
    displayName: "Opus 5",
    description: "Best for everyday, complex tasks",
    supportsAdaptiveThinking: true,
  };
  modelFromDiscovery({ ...row, supportsThinkingOff: false });
  assert.equal(supportsDisabledThinking("claude-opus-5"), false);
  modelFromDiscovery({ ...row, supportsThinkingOff: true });
  assert.equal(supportsDisabledThinking("claude-opus-5"), true);
  modelFromDiscovery(row);
  assert.equal(supportsDisabledThinking("claude-opus-5"), true);
});
