export function main(): number {
  const set = new Set([1, 2, 3]);
  set.delete(1);
  return set.size;
}
