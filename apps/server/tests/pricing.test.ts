import { describe, expect, it } from "vitest";
import { LocalPricingSnapshotSchema } from "@agent-farm/contracts";
import { pricingSnapshotHash } from "@agent-farm/store";
import { REVIEWED_OPENAI_PRICING_SNAPSHOT, reviewedPricingProvider } from "../src/pricing.js";

describe("reviewed pricing provider", () => {
  it("is immutable, canonical, and pins official Auto-review Luna pricing provenance", () => {
    expect(LocalPricingSnapshotSchema.parse(REVIEWED_OPENAI_PRICING_SNAPSHOT)).toEqual(REVIEWED_OPENAI_PRICING_SNAPSHOT);
    const { snapshotHash, ...body } = REVIEWED_OPENAI_PRICING_SNAPSHOT;
    expect(pricingSnapshotHash(body)).toBe(snapshotHash);
    expect(REVIEWED_OPENAI_PRICING_SNAPSHOT.sourceUrls.every((url) => url.startsWith("https://"))).toBe(true);
    expect(REVIEWED_OPENAI_PRICING_SNAPSHOT.rates["gpt-5.6-luna"]).toEqual({
      inputPerMillionUsd: 0.2,
      cachedInputPerMillionUsd: 0.02,
      outputPerMillionUsd: 1.2,
    });
    expect(REVIEWED_OPENAI_PRICING_SNAPSHOT.sourceUrls).toContain("https://developers.openai.com/api/docs/models/gpt-5.6-luna");
    expect(REVIEWED_OPENAI_PRICING_SNAPSHOT.note).toMatch(/Auto-review.*GPT-5\.6 Luna/iu);
    expect(reviewedPricingProvider().snapshot).toEqual(REVIEWED_OPENAI_PRICING_SNAPSHOT);
  });
});
