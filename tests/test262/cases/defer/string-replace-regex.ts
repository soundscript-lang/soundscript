export function main(): string {
  return RegExp.prototype[Symbol.replace].call(/𠮷/g, '𠮷a𠮷b𠮷', '-');
}
