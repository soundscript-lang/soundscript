export function main(): boolean {
  const first = {};
  const second = {};
  const third = {};
  const store = new WeakSet<object>();
  store.add(first);
  store.add(second);
  store.add(third);
  store.delete(third);
  return store.has(second);
}
