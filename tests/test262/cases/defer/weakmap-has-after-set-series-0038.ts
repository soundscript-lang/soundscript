export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 38);
  map.set(right, 39);
  return map.has(right);
}
