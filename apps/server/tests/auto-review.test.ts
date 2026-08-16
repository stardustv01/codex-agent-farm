import { describe, expect, it } from "vitest";

import {
  CODEX_AUTO_REVIEW_CANONICAL_MODEL,
  CODEX_AUTO_REVIEW_DISPLAY_NAME,
  canonicalCodexModel,
  isCodexAutoReviewModel,
} from "../src/auto-review.js";

describe("Codex Auto-review identity", () => {
  it("canonicalizes only the Auto-review telemetry alias to GPT-5.6 Luna", () => {
    expect(isCodexAutoReviewModel("codex-auto-review")).toBe(true);
    expect(isCodexAutoReviewModel("codex_auto_review")).toBe(true);
    expect(canonicalCodexModel("codex-auto-review")).toBe(CODEX_AUTO_REVIEW_CANONICAL_MODEL);
    expect(CODEX_AUTO_REVIEW_DISPLAY_NAME).toBe("Codex Auto-review");
  });

  it("does not rewrite an explicit historical model identity", () => {
    expect(isCodexAutoReviewModel("gpt-5.4")).toBe(false);
    expect(canonicalCodexModel("gpt-5.4")).toBe("gpt-5.4");
    expect(canonicalCodexModel("gpt-5.3-codex-spark")).toBe("gpt-5.3-codex-spark");
  });
});
