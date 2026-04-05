export function main(): number {
  const first = {};
  const second = {};
  const third = {};
  const store = new WeakMap<object, number>();
  store.set(first, 0);
  store.set(second, 1);
  store.set(third, 2);
  store.delete(third);
  return store.get(second)!;
}
