export function main(): number {
  const set = new Set([1, 2]);
  set.add(2);
  set.add(3);
  return set.size;
}
