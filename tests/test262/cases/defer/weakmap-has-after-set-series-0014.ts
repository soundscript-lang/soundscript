export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 14);
  map.set(right, 15);
  return map.has(right);
}
