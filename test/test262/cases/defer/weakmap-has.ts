export function main(): boolean {
  const store = new WeakMap<object, number>();
  const key = {};
  store.set(key, 1);
  return store.has(key);
}
