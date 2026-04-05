export function main(): boolean {
  const first = {};
  const second = {};
  const store = new WeakMap<object, number>();
  store.set(first, 1);
  store.set(second, 2);
  store.delete(second);
  return store.has(first);
}
