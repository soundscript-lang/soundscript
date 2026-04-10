export function main(): number | undefined {
  const key = {};
  const store = new WeakMap<object, number>();
  store.set(key, 1);
  store.set(key, 2);
  store.delete(key);
  return store.get(key);
}
