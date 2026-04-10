export function main(): boolean {
  const key = {};
  const store = new WeakMap<object, number>();
  store.set(key, 1);
  store.delete(key);
  store.set(key, 2);
  return store.delete(key);
}
