export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 34);
  map.set(right, 35);
  return map.has(right);
}
