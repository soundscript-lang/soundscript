export function main(): boolean {
  const first = {};
  const second = {};
  const store = new WeakSet<object>();
  store.add(first);
  store.add(second);
  store.delete(second);
  store.add(first);
  return store.has(first);
}
