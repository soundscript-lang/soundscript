export function main(): boolean {
  const key = {};
  const map = new WeakMap<object, number>([[key, 1]]);
  return map.set(key, 1).set(key, 1) === map;
}
