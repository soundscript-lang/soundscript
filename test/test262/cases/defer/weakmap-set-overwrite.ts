export function main(): number {
  const key = {};
  const store = new WeakMap<object, number>();
  store.set(key, 1);
  store.set(key, 2);
  return store.get(key) ?? 0;
}
