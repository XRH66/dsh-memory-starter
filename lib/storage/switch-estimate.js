// ESTIMATE ONLY, for the "switch vector model" confirmation. Not a billing
// figure and not the real tokenizer: one CJK character ~ one token, other text
// ~ four characters per token. Never record this in the usage ledger.
export const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu;

export function estimateTokens({ length, cjk } = {}) {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(cjk) || cjk < 0 || cjk > length) return null;
  return cjk + Math.ceil((length - cjk) / 4);
}
