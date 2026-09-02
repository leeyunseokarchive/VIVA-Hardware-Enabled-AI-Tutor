/**
 * Pure token→cost math for the API usage/cost tracking feature (History
 * screen). No RN or network dependencies - safe to unit test directly.
 *
 * Pricing captured from the Google AI pricing page (standard tier,
 * 2026-07-08) - see docs/superpowers/plans/2026-07-08-model-swap-solve-
 * toggle-cost-tracking.md "Global Constraints" for the source figures. This
 * is an approximate in-app cost estimate, not exact billing.
 */
import type { SessionUsageSummary, TokenUsage } from '../types/ApiUsage';

/** gemini-3.1-flash (gemini.service.ts text calls: analyzeImage,
 * analyzeConceptQuestion, evaluateStudentInput). */
export const TEXT_MODEL_PRICING_USD_PER_MILLION = {
  input: 1.5,
  output: 9.0,
};

/** gemini-3.1-flash-image (board.service.ts image calls). The flat fee is per
 * generated image AT THE RESOLUTION board.service.ts asks for - so it reads
 * the SAME env knob (EXPO_PUBLIC_GEMINI_IMAGE_SIZE) instead of hardcoding a
 * figure that silently drifts when the resolution is A/B'd.
 *   gemini-3.1-flash-image:      1K $0.067 / 2K $0.101 / 4K $0.151
 *   gemini-3.1-flash-lite-image: 1K $0.034 (previous model, 1K only)
 *   gemini-3-pro-image:          1K/2K $0.134 / 4K $0.24 (escalation option)
 * 전사 1회 + 오버레이 전환(D-21) 후 이미지 생성은 세션당 최대 2장이다. */
const IMAGE_FLAT_BY_SIZE: Record<string, number> = {
  '1K': 0.067,
  '2K': 0.101,
  '4K': 0.151,
};
export const IMAGE_MODEL_PRICING_USD = {
  inputPerMillion: 0.25,
  outputTextPerMillion: 1.5,
  outputImageFlat:
    IMAGE_FLAT_BY_SIZE[process.env.EXPO_PUBLIC_GEMINI_IMAGE_SIZE || '1K'] ??
    IMAGE_FLAT_BY_SIZE['1K'],
};

export function computeTextCallCostUsd(usage: TokenUsage): number {
  return (
    (usage.promptTokens / 1_000_000) * TEXT_MODEL_PRICING_USD_PER_MILLION.input +
    (usage.candidateTokens / 1_000_000) * TEXT_MODEL_PRICING_USD_PER_MILLION.output
  );
}

export function computeImageCallCostUsd(usage: TokenUsage): number {
  return (
    (usage.promptTokens / 1_000_000) * IMAGE_MODEL_PRICING_USD.inputPerMillion +
    (usage.candidateTokens / 1_000_000) * IMAGE_MODEL_PRICING_USD.outputTextPerMillion +
    IMAGE_MODEL_PRICING_USD.outputImageFlat
  );
}

export function addTextUsage(summary: SessionUsageSummary, usage: TokenUsage): SessionUsageSummary {
  const usd = computeTextCallCostUsd(usage);
  return {
    textCalls: summary.textCalls + 1,
    imageCalls: summary.imageCalls,
    promptTokens: summary.promptTokens + usage.promptTokens,
    candidateTokens: summary.candidateTokens + usage.candidateTokens,
    totalTokens: summary.totalTokens + usage.totalTokens,
    costUsd: summary.costUsd + usd,
  };
}

export function addImageUsage(
  summary: SessionUsageSummary,
  usage: TokenUsage,
): SessionUsageSummary {
  const usd = computeImageCallCostUsd(usage);
  return {
    textCalls: summary.textCalls,
    imageCalls: summary.imageCalls + 1,
    promptTokens: summary.promptTokens + usage.promptTokens,
    candidateTokens: summary.candidateTokens + usage.candidateTokens,
    totalTokens: summary.totalTokens + usage.totalTokens,
    costUsd: summary.costUsd + usd,
  };
}

export function formatWithCommas(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}
