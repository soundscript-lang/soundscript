export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 35);
  map.set(right, 36);
  return map.has(right);
}
