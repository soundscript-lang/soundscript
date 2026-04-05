export function main(): number {
  const set = new Set([1, 2, 3]);
  set.delete(2);
  return set.size;
}
