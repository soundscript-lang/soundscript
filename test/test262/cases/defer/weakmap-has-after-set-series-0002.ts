export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 2);
  map.set(right, 3);
  return map.has(right);
}
