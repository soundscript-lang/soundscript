export function main(): number | undefined {
  const store = new WeakMap<object, number>();
  const key = {};
  return store.get(key);
}
