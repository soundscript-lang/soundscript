export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 13);
  map.set(right, 14);
  return map.has(right);
}
