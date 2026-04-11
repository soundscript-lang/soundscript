export function main(): boolean {
  const value = {};
  const set = new WeakSet<object>();
  return set.delete(value);
}
