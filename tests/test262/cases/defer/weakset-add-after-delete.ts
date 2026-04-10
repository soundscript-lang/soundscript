export function main(): boolean {
  const value = {};
  const set = new WeakSet<object>();
  set.add(value);
  set.delete(value);
  set.add(value);
  return set.has(value);
}
