export function main(): boolean {
  const value = {};
  const set = new WeakSet<object>();
  set.add(value);
  set.delete(value);
  return set.has(value);
}
