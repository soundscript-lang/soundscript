export function main(): boolean {
  return new globalThis.Set([1, 2]).has(2);
}
