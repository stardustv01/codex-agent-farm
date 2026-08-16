import type { LocalPriceRate, LocalPricingSnapshot, LocalTokenUsage } from "./local.js";

export interface CostTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly model?: string;
  readonly usage?: LocalTokenUsage;
}

export interface CostCalculation {
  readonly selfMicros?: number;
  readonly childrenMicros?: number;
  readonly totalMicros?: number;
  readonly knownTotalMicros: number;
  readonly status: "estimated" | "partial" | "unavailable";
  readonly reason?: string;
}

export interface CostUsageSegment {
  readonly model: string;
  readonly usage: LocalTokenUsage;
}

export type SegmentCostCalculation =
  | { readonly status: "estimated"; readonly selfMicros: number }
  | { readonly status: "partial"; readonly knownSelfMicros: number; readonly reason: "usage-segments-incomplete" }
  | { readonly status: "unavailable"; readonly reason: "usage-segments-incomplete" | "pricing-unavailable" | "usage-unavailable" };

/** Price exact per-invocation segments; never smear a final model over rerouted cumulative usage. */
export function estimateSegmentedSelfCost(
  segments: readonly CostUsageSegment[] | undefined,
  complete: boolean,
  pricing: LocalPricingSnapshot,
): SegmentCostCalculation {
  if (segments === undefined || segments.length === 0 || segments.length > 10_000) {
    return { status: "unavailable", reason: "usage-segments-incomplete" };
  }
  let selfMicros = 0;
  for (const segment of segments) {
    const rate = pricing.rates[segment.model];
    if (rate === undefined) return { status: "unavailable", reason: "pricing-unavailable" };
    const cost = estimateSelfCost(segment.usage, rate, pricing);
    if (cost === undefined) return { status: "unavailable", reason: "usage-unavailable" };
    selfMicros += cost;
    if (!Number.isSafeInteger(selfMicros)) return { status: "unavailable", reason: "usage-unavailable" };
  }
  return complete
    ? { status: "estimated", selfMicros }
    : { status: "partial", knownSelfMicros: selfMicros, reason: "usage-segments-incomplete" };
}

/**
 * Codex reports `input_tokens` as the prompt total and separately reports the
 * cached/cache-write portions. Cached tokens are therefore subtracted before
 * applying the uncached rate; reasoning output is not added a second time.
 */
/** Return integer USD microdollars so recursive sums cannot drift as floats. */
export function estimateSelfCost(usage: LocalTokenUsage, rate: LocalPriceRate, rules?: Pick<LocalPricingSnapshot, "longContextThresholdInputTokens" | "longContextInputMultiplier" | "longContextOutputMultiplier" | "cacheWriteMultiplier">): number | undefined {
  if (usage.totalTokens === 0 && usage.inputTokens === 0 && usage.outputTokens === 0) return undefined;
  if (usage.cachedInputTokens > usage.inputTokens || usage.cacheWriteInputTokens > usage.inputTokens || usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens) return undefined;
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) return undefined;
  const longContext = rules !== undefined && usage.inputTokens > rules.longContextThresholdInputTokens;
  const inputMultiplier = longContext ? rules.longContextInputMultiplier : 1;
  const outputMultiplier = longContext ? rules.longContextOutputMultiplier : 1;
  const uncachedInput = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
  const micros = uncachedInput * rate.inputPerMillionUsd * inputMultiplier +
    usage.cachedInputTokens * rate.cachedInputPerMillionUsd * inputMultiplier +
    usage.cacheWriteInputTokens * rate.inputPerMillionUsd * (rules?.cacheWriteMultiplier ?? 1.25) * inputMultiplier +
    usage.outputTokens * rate.outputPerMillionUsd * outputMultiplier;
  return Number.isFinite(micros) && micros >= 0 ? Math.round(micros) : undefined;
}

export function calculateCostTree(nodes: readonly CostTreeNode[], pricing: LocalPricingSnapshot): ReadonlyMap<string, CostCalculation> {
  const byId = new Map<string, CostTreeNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error("cost tree duplicate node");
    byId.set(node.id, node);
  }
  const children = new Map<string, CostTreeNode[]>();
  for (const node of nodes) {
    if (node.parentId !== null) {
      if (!byId.has(node.parentId) || node.parentId === node.id) throw new Error("cost tree orphan");
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    }
  }
  const result = new Map<string, CostCalculation>();
  const visiting = new Set<string>();
  const visit = (node: CostTreeNode): CostCalculation => {
    const prior = result.get(node.id);
    if (prior) return prior;
    if (visiting.has(node.id)) throw new Error("cost tree cycle");
    visiting.add(node.id);
    const rate = node.model === undefined ? undefined : pricing.rates[node.model];
    const selfMicros = node.usage === undefined || rate === undefined ? undefined : estimateSelfCost(node.usage, rate, pricing);
    let childrenMicros = 0;
    let childUnavailable = false;
    let childPartial = false;
    for (const child of children.get(node.id) ?? []) {
      const childCost = visit(child);
      childrenMicros += childCost.knownTotalMicros;
      if (childCost.totalMicros === undefined) {
        if (childCost.status === "partial") childPartial = true;
        else childUnavailable = true;
      }
    }
    const value: CostCalculation = selfMicros === undefined
      ? { status: childUnavailable || childPartial || childrenMicros > 0 ? "partial" : "unavailable", knownTotalMicros: childrenMicros, ...(childrenMicros > 0 ? { childrenMicros } : {}), reason: rate === undefined ? "pricing-unavailable" : "usage-unavailable" }
      : childUnavailable || childPartial
        ? { status: "partial", selfMicros, knownTotalMicros: selfMicros + childrenMicros, ...(childrenMicros > 0 ? { childrenMicros } : {}), reason: "descendant-cost-unavailable" }
        : { status: "estimated", selfMicros, childrenMicros, totalMicros: selfMicros + childrenMicros, knownTotalMicros: selfMicros + childrenMicros };
    visiting.delete(node.id);
    result.set(node.id, value);
    return value;
  };
  for (const node of nodes) visit(node);
  return result;
}
