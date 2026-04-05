export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 1);
  map.set(right, 2);
  return map.has(right);
}
