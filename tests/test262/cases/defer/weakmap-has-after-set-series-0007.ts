export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 7);
  map.set(right, 8);
  return map.has(right);
}
