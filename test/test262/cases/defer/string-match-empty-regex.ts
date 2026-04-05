export function main(): number {
  const text = '𠮷a𠮷b𠮷c👨‍👩‍👧‍👦d';
  return RegExp.prototype[Symbol.match].call(/𠮷/u, text)?.length ?? 0;
}
