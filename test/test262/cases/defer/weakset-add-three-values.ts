export function main(): boolean {
  const first = {};
  const second = {};
  const third = {};
  const store = new WeakSet<object>();
  store.add(first);
  store.add(second);
  store.add(third);
  return store.has(first) && store.has(second) && store.has(third);
}
