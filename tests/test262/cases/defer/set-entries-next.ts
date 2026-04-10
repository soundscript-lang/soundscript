export function main(): number {
  const set = new Set([2, 3]);
  const first = set.entries().next().value;
  return first ? first[0] + first[1] : 0;
}
