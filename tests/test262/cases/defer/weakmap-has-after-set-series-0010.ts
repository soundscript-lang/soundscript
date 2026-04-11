export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 10);
  map.set(right, 11);
  return map.has(right);
}
