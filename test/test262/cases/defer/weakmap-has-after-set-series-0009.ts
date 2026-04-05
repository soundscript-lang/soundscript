export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 9);
  map.set(right, 10);
  return map.has(right);
}
