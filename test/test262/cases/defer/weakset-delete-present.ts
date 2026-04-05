export function main(): boolean {
  const value = {};
  const set = new WeakSet<object>();
  set.add(value);
  return set.delete(value);
}
