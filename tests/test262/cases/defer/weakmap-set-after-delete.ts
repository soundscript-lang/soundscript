export function main(): number {
  const key = {};
  const store = new WeakMap<object, number>();
  store.set(key, 1);
  store.delete(key);
  store.set(key, 1);
  return store.get(key)!;
}
