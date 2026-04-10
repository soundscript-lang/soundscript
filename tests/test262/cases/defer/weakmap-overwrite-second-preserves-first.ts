export function main(): number {
  const first = {};
  const second = {};
  const store = new WeakMap<object, number>();
  store.set(first, 0);
  store.set(second, 1);
  store.set(second, 2);
  return store.get(first) ?? 0;
}
