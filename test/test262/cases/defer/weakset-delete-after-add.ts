export function main(): boolean {
  const value = {};
  const store = new WeakSet<object>();
  store.add(value);
  return store.delete(value);
}
