export function main(): boolean {
  const first = {};
  const second = {};
  const store = new WeakSet<object>();
  store.add(first);
  store.add(second);
  return store.has(first) && store.has(second);
}
