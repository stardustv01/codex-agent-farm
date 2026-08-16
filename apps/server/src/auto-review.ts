/**
 * Codex emits this role label in local telemetry. OpenAI's current product
 * authority identifies Auto-review as GPT-5.6 Luna, so the alias must not be
 * treated as a separately priced model.
 */
export const CODEX_AUTO_REVIEW_TELEMETRY_MODEL = "codex-auto-review" as const;
export const CODEX_AUTO_REVIEW_CANONICAL_MODEL = "gpt-5.6-luna" as const;
export const CODEX_AUTO_REVIEW_DISPLAY_NAME = "Codex Auto-review" as const;

export function isCodexAutoReviewModel(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-") === CODEX_AUTO_REVIEW_TELEMETRY_MODEL;
}

export function canonicalCodexModel(value: string): string {
  return isCodexAutoReviewModel(value) ? CODEX_AUTO_REVIEW_CANONICAL_MODEL : value;
}
