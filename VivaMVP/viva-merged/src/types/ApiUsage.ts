/**
 * Shared token-usage/cost shapes for API cost tracking (VIVA history feature).
 * Kept dependency-free (no RN, no service imports) so both gemini.service.ts
 * and board.service.ts can import it without a circular dependency.
 */

/** Raw token counts from a single Gemini `generateContent` call's
 * `usageMetadata`. */
export interface TokenUsage {
  promptTokens: number;
  candidateTokens: number;
  totalTokens: number;
}

export const EMPTY_TOKEN_USAGE: TokenUsage = {
  promptTokens: 0,
  candidateTokens: 0,
  totalTokens: 0,
};

/** Converts a raw Gemini REST/SDK `usageMetadata` object into `TokenUsage`.
 * Accepts `undefined`/`null` (e.g. mocked test responses with no usage data)
 * and defaults every field to 0. */
export function toTokenUsage(
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  } | null,
): TokenUsage {
  return {
    promptTokens: usageMetadata?.promptTokenCount ?? 0,
    candidateTokens: usageMetadata?.candidatesTokenCount ?? 0,
    totalTokens: usageMetadata?.totalTokenCount ?? 0,
  };
}

/** Running total of API usage/cost for one tutoring session, persisted on
 * `TutoringSession.usage` and `SessionHistoryEntry.usage`. */
export interface SessionUsageSummary {
  textCalls: number;
  imageCalls: number;
  promptTokens: number;
  candidateTokens: number;
  totalTokens: number;
  costUsd: number;
}

export const EMPTY_USAGE_SUMMARY: SessionUsageSummary = {
  textCalls: 0,
  imageCalls: 0,
  promptTokens: 0,
  candidateTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};
