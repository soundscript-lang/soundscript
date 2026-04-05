export function main(): boolean {
  const key = {};
  const map = new WeakMap<object, number>();
  map.set(key, 1);
  const missing = {};
  return map.delete(missing);
}
