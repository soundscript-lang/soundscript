export function main(): null {
  const text = '𠮷a𠮷b𠮷c👨‍👩‍👧‍👦d';
  const result = RegExp.prototype[Symbol.match].call(/x/u, text);
  return result === null ? null : null;
}
