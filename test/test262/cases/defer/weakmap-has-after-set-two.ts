export function main(first: object, second: object): boolean {
  const store = new WeakMap<object, number>();
  store.set(first, 1);
  store.set(second, 2);
  return store.has(second);
}
