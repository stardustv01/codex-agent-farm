import { describe, expect, it } from "vitest";
import { calculateCostTree, estimateSegmentedSelfCost, estimateSelfCost } from "../src/cost.js";
import type { LocalPricingSnapshot, LocalTokenUsage } from "../src/local.js";

const pricing: LocalPricingSnapshot = {
  snapshotId: "synthetic-test-v1",
  authority: "operator-reviewed-official",
  sourceUrls: ["https://example.com/test-pricing"],
  retrievedAt: "2026-08-12T00:00:00.000Z",
  verifiedAt: "2026-08-12T00:00:00.000Z",
  currency: "USD",
  standardInputMultiplier: 1,
  longContextThresholdInputTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
  cacheWriteMultiplier: 1.25,
  snapshotHash: "0000000000000000000000000000000000000000000000000000000000000000",
  rates: { synthetic: { inputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.2, outputPerMillionUsd: 12 } },
};
const usage: LocalTokenUsage = { inputTokens: 1000, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1100 };

describe("local cost estimation", () => {
  it("subtracts cached input and does not double-count reasoning output", () => {
    expect(estimateSelfCost(usage, pricing.rates.synthetic!)).toBe(2840);
  });
  it("aggregates each descendant exactly once", () => {
    const costs = calculateCostTree([
      { id: "root", parentId: null, model: "synthetic", usage },
      { id: "child", parentId: "root", model: "synthetic", usage },
    ], pricing);
    expect(costs.get("child")?.status).toBe("estimated");
    expect(costs.get("root")?.totalMicros).toBe(costs.get("root")?.selfMicros! + costs.get("child")?.totalMicros!);
  });
  it("does not turn unavailable usage into a free estimate", () => {
    const costs = calculateCostTree([{ id: "root", parentId: null, model: "synthetic" }], pricing);
    expect(costs.get("root")).toMatchObject({ status: "unavailable", reason: "usage-unavailable" });
    expect(costs.get("root")?.totalMicros).toBeUndefined();
  });
  it("marks a known child subtotal as partial when parent self usage is unavailable", () => {
    const costs = calculateCostTree([
      { id: "root", parentId: null, model: "synthetic" },
      { id: "child", parentId: "root", model: "synthetic", usage },
    ], pricing);
    expect(costs.get("root")).toMatchObject({
      status: "partial",
      childrenMicros: costs.get("child")?.totalMicros,
      knownTotalMicros: costs.get("child")?.totalMicros,
    });
    expect(costs.get("root")?.totalMicros).toBeUndefined();
  });
  it("rejects inconsistent categorized totals", () => {
    expect(estimateSelfCost({ ...usage, totalTokens: 1 }, pricing.rates.synthetic!)).toBeUndefined();
    expect(estimateSelfCost({ ...usage, cachedInputTokens: 900, cacheWriteInputTokens: 200 }, pricing.rates.synthetic!)).toBeUndefined();
  });
  it("rejects duplicate and orphan nodes", () => {
    expect(() => calculateCostTree([{ id: "a", parentId: null }, { id: "a", parentId: null }], pricing)).toThrow("duplicate");
    expect(() => calculateCostTree([{ id: "a", parentId: "missing" }], pricing)).toThrow("orphan");
  });
  it("rejects cycles", () => {
    expect(() => calculateCostTree([{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }], pricing)).toThrow("cycle");
  });
  it("prices rerouted invocations independently with cache-write and long-context rules", () => {
    const long = { inputTokens: 300_000, cachedInputTokens: 100_000, cacheWriteInputTokens: 20_000, outputTokens: 10_000, reasoningOutputTokens: 5_000, totalTokens: 310_000 };
    const result = estimateSegmentedSelfCost([
      { model: "synthetic", usage },
      { model: "synthetic", usage: long },
    ], true, pricing);
    // normal segment 2,840µUSD + long segment 1,040,000µUSD. Cached and
    // cache-write input receive the long-input multiplier; output receives
    // the reviewed 1.5x multiplier.
    expect(result).toEqual({ status: "estimated", selfMicros: 1_042_840 });
  });
  it("keeps segment cost unavailable for gaps, unknown reroutes, or invalid usage", () => {
    expect(estimateSegmentedSelfCost([{ model: "synthetic", usage }], false, pricing)).toEqual({ status: "partial", knownSelfMicros: 2_840, reason: "usage-segments-incomplete" });
    expect(estimateSegmentedSelfCost([{ model: "rerouted-unknown", usage }], true, pricing)).toEqual({ status: "unavailable", reason: "pricing-unavailable" });
    expect(estimateSegmentedSelfCost([{ model: "synthetic", usage: { ...usage, totalTokens: 1 } }], true, pricing)).toEqual({ status: "unavailable", reason: "usage-unavailable" });
  });
});
