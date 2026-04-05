export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 8);
  map.set(right, 9);
  return map.has(right);
}
