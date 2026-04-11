export function main(): boolean {
  const store = new WeakMap<object, number>();
  return store.delete({});
}
