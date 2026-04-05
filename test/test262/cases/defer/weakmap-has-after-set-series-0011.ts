export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 11);
  map.set(right, 12);
  return map.has(right);
}
