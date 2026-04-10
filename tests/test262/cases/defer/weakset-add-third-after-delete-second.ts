export function main(): boolean {
  const first = {};
  const second = {};
  const third = {};
  const store = new WeakSet<object>();
  store.add(first);
  store.add(second);
  store.delete(second);
  store.add(third);
  return store.has(third);
}
