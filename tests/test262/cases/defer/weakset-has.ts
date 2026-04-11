export function main(): boolean {
  const store = new WeakSet<object>();
  const value = {};
  store.add(value);
  return store.has(value);
}
