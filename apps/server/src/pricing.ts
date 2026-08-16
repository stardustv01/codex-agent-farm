import { LocalPricingSnapshotSchema, type LocalPricingSnapshot } from "@agent-farm/contracts";
import { pricingSnapshotHash } from "@agent-farm/store";

/** Immutable operator-reviewed API-equivalent pricing; no runtime network fetch. */
const body = Object.freeze({
  snapshotId: "openai-api-2026-08-14-auto-review-luna-v2",
  authority: "operator-reviewed-official" as const,
  sourceUrls: [
    "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
    "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/",
  ],
  retrievedAt: "2026-08-14T00:00:00.000Z",
  verifiedAt: "2026-08-14T00:00:00.000Z",
  currency: "USD" as const,
  rates: {
    "gpt-5.6-sol": { inputPerMillionUsd: 5, cachedInputPerMillionUsd: 0.5, outputPerMillionUsd: 30 },
    "gpt-5.6-terra": { inputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.2, outputPerMillionUsd: 12 },
    "gpt-5.6-luna": { inputPerMillionUsd: 0.2, cachedInputPerMillionUsd: 0.02, outputPerMillionUsd: 1.2 },
  },
  standardInputMultiplier: 1 as const,
  longContextThresholdInputTokens: 272_000 as const,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
  cacheWriteMultiplier: 1.25,
  note: "Official per-model pricing. Codex Auto-review telemetry is canonically attributed to GPT-5.6 Luna for new or changed usage; completed estimates remain pinned and are never silently repriced.",
});

export const REVIEWED_OPENAI_PRICING_SNAPSHOT: LocalPricingSnapshot = Object.freeze(LocalPricingSnapshotSchema.parse({
  ...body,
  snapshotHash: pricingSnapshotHash(body),
}));

export interface ReviewedPricingProvider {
  readonly snapshot: LocalPricingSnapshot;
}

export function reviewedPricingProvider(snapshot: LocalPricingSnapshot = REVIEWED_OPENAI_PRICING_SNAPSHOT): ReviewedPricingProvider {
  return Object.freeze({ snapshot: LocalPricingSnapshotSchema.parse(snapshot) });
}
