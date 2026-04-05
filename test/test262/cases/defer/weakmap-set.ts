export function main(): boolean {
  const map = new WeakMap<object, number>();
  const key = {};
  return map.set(key, 1) === map;
}
