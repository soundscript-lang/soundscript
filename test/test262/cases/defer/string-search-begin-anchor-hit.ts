export function main(): number {
  const text = '𠮷a𠮷b𠮷c👨‍👩‍👧‍👦d';
  return RegExp.prototype[Symbol.search].call(/a/, text);
}
