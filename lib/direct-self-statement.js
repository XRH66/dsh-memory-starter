/** Conservative evidence gate for a direct self-statement, independent of a chat transport. */
export function isDirectSelfStatement(text) {
  return typeof text==='string' && /^我(?:现在|以后|平时|长期|一直|通常|每天|周末)?(?:喜欢|不喜欢|改喝|喝|用|住在|叫|希望|要求|决定)/.test(text)
    && !/[?？]|什么|啥|吗|听说|据说|他说|她说/.test(text);
}
