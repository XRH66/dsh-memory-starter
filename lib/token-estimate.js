/** Approximation only: not a provider bill or a model-specific tokenizer. */
export function characterTokenCost(char) {
  return /\p{Script=Han}/u.test(char) ? 0.6 : char.codePointAt(0) < 128 ? 0.3 : 1;
}

export function estimateTokens(text) {
  let units = 0;
  for (const char of String(text)) units += characterTokenCost(char);
  return Math.ceil(units);
}
