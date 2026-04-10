export function main(first: object, second: object): boolean {
  const set = new WeakSet<object>();
  set.add(first);
  set.add(second);
  return set.has(second);
}
