import assert from "node:assert/strict";
import test from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
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
  // The release is derived from the installed catalog (one past its newest Fable 5.x), so this keeps testing
  // "not in the catalog yet" after Pi adds a release. A fixed id stopped doing that when Pi 1.5.1 added Fable 5.2.
  const newest = getBuiltinModels("anthropic")
    .map((model) => ({ model, minor: /^claude-fable-5-(\d{1,2})$/u.exec(model.id)?.[1] }))
    .filter((entry): entry is { model: (typeof entry)["model"]; minor: string } => entry.minor !== undefined)
    .sort((left, right) => Number(right.minor) - Number(left.minor))[0];
  assert.ok(newest, "the installed catalog lists a Fable 5.x release");
  const next = Number(newest.minor) + 1;
  const id = `claude-fable-5-${next}`;
  // The row shape Claude Code reports for a new point release: no "1M context" text and no [1m] suffix.
  const fable = modelFromDiscovery({
    value: "fable",
    resolvedModel: id,
    displayName: `Fable 5.${next}`,
    description: "For your toughest challenges",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsThinkingOff: false,
  });
  assert.equal(fable.id, id);
  assert.equal(fable.name, `Fable 5.${next} (Claude Code)`);
  assert.equal(fable.contextWindow, newest.model.contextWindow);
  assert.equal(fable.maxTokens, newest.model.maxTokens);
  assert.equal(fable.thinkingLevelMap?.off, null);
  // Pricing is not assumed to carry over between releases.
  assert.deepEqual(fable.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(supportsNativeToolChanges(id), newest.model.compat?.supportsMidConvoToolChanges === true);
  assert.equal(supportsDisabledThinking(id), false);
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
