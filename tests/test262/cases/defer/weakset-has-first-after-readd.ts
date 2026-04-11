export function main(): boolean {
  const first = {};
  const store = new WeakSet<object>();
  store.add(first);
  store.delete(first);
  store.add(first);
  return store.has(first);
}
