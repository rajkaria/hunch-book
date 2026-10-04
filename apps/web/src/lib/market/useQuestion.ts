"use client";

import { useChainClock } from "../hooks";
import { friendlyQuestion } from "./title";

/** A resolver sentence that names block numbers: a Perpl market's. */
const NAMES_BLOCKS = /block \d/;

/**
 * For rows that only carry a market's question text (from the indexer or a fill): returns a function
 * that reads Perpl block windows in it as estimated clock times (lib/market/title.ts). The chain clock
 * is read only when one of `questions` names blocks.
 */
export function useFriendlyQuestions(
  questions: readonly (string | null | undefined)[],
): (question: string | null | undefined) => string | null {
  const clock = useChainClock(questions.some((q) => q && NAMES_BLOCKS.test(q)));
  return (question) => (question ? friendlyQuestion(question, clock) : null);
}
