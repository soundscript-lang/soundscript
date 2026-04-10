export function main(): number | undefined {
  const key = {};
  const map = new WeakMap<object, number>();
  map.set(key, 0);
  return map.get(key);
}
