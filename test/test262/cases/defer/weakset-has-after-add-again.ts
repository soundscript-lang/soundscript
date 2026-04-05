export function main(): boolean {
  const value = {};
  const store = new WeakSet<object>();
  store.add(value);
  store.delete(value);
  store.add(value);
  return store.has(value);
}
