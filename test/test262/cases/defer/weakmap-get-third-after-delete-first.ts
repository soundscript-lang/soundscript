export function main(): number {
  const first = {};
  const second = {};
  const third = {};
  const store = new WeakMap<object, number>();
  store.set(first, 1);
  store.set(second, 2);
  store.set(third, 3);
  store.delete(first);
  return store.get(third) ?? 0;
}
