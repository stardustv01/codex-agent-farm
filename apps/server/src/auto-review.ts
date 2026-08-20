/**
 * Codex emits this role label in local telemetry. OpenAI's current product
 * authority identifies Auto-review as GPT-5.6 Luna, so the alias must not be
 * treated as a separately priced model.
 */
export const CODEX_AUTO_REVIEW_TELEMETRY_MODEL = "codex-auto-review" as const;
export const CODEX_AUTO_REVIEW_CANONICAL_MODEL = "gpt-5.6-luna" as const;
export const CODEX_AUTO_REVIEW_DISPLAY_NAME = "Codex Auto-review" as const;

// The local OpenCode adapter prefixes models routed through its Responses
// provider.  Pricing is keyed by the underlying Codex model, so strip only
// this known transport wrapper; unknown provider/model identities remain
// untouched and correctly stay unpriced.
const OPENCODE_RESPONSES_MODEL_PREFIX = "opencode-go-responses/";
const PRICED_CODEX_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

export function isCodexAutoReviewModel(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-") === CODEX_AUTO_REVIEW_TELEMETRY_MODEL;
}

export function canonicalCodexModel(value: string): string {
  const candidateModel = value.startsWith(OPENCODE_RESPONSES_MODEL_PREFIX)
    ? value.slice(OPENCODE_RESPONSES_MODEL_PREFIX.length)
    : value;
  const routedModel = value.startsWith(OPENCODE_RESPONSES_MODEL_PREFIX) &&
    !PRICED_CODEX_MODELS.has(candidateModel) && !isCodexAutoReviewModel(candidateModel)
    ? value
    : candidateModel;
  return isCodexAutoReviewModel(routedModel) ? CODEX_AUTO_REVIEW_CANONICAL_MODEL : routedModel;
}
