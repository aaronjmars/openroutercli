import assert from "node:assert/strict";
import test from "node:test";
import {
  attachPerformance,
  baseModelId,
  filterByPerformance,
  sortModelRows,
} from "../src/commands/models.js";

test("baseModelId strips only a trailing rankings date stamp", () => {
  assert.equal(baseModelId("google/gemini-4-neon-20261118"), "google/gemini-4-neon");
  assert.equal(baseModelId("openai/gpt-6.2-astra-pro"), "openai/gpt-6.2-astra-pro");
  assert.equal(baseModelId("author/slug-2026"), "author/slug-2026");
  assert.equal(baseModelId(""), "");
});

test("attachPerformance matches dated rankings slugs to undated catalog ids", () => {
  const rows = [{ id: "google/gemini-4-neon" }, { id: "unknown/model" }];
  const byId = new Map([["google/gemini-4-neon", { p50_latency: 120, p50_throughput: 218 }]]);
  const out = attachPerformance(rows, byId);
  assert.equal(out[0].performance.p50_latency, 120);
  assert.equal(out[0].performance.p50_throughput, 218);
  assert.equal(out[1].performance, undefined);
});

test("filterByPerformance drops rows with no measurement", () => {
  const rows = [
    { id: "fast", performance: { p50_latency: 120, p50_throughput: 300 } },
    { id: "slow", performance: { p50_latency: 900, p50_throughput: 50 } },
    { id: "unmeasured" },
  ];
  const byLatency = filterByPerformance(rows, { "max-latency": "300" });
  assert.deepEqual(
    byLatency.map((r) => r.id),
    ["fast"],
  );
  const byThroughput = filterByPerformance(rows, { "min-throughput": "100" });
  assert.deepEqual(
    byThroughput.map((r) => r.id),
    ["fast"],
  );
  assert.equal(filterByPerformance(rows, {}).length, 3);
});

test("sortModelRows ranks latency ascending and sinks unmeasured rows", () => {
  const rows = [
    { id: "unmeasured" },
    { id: "slow", performance: { p50_latency: 900 } },
    { id: "fast", performance: { p50_latency: 120 } },
  ];
  assert.deepEqual(
    sortModelRows(rows, "latency").map((r) => r.id),
    ["fast", "slow", "unmeasured"],
  );
});

test("sortModelRows ranks throughput descending and sinks unmeasured rows", () => {
  const rows = [
    { id: "unmeasured" },
    { id: "low", performance: { p50_throughput: 50 } },
    { id: "high", performance: { p50_throughput: 800 } },
  ];
  assert.deepEqual(
    sortModelRows(rows, "throughput").map((r) => r.id),
    ["high", "low", "unmeasured"],
  );
});

test("sortModelRows still rejects unknown fields", () => {
  assert.throws(() => sortModelRows([], "bogus"), /Unknown --sort field/);
});
