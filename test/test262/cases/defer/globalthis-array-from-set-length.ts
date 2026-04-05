export function main(): number {
  return globalThis.Array.from(new Set([1, 2, 3])).length;
}
