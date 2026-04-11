export function main(): boolean {
  const value = new Set([1, 2, 3]).values();
  return value instanceof Object;
}
