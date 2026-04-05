export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 12);
  map.set(right, 13);
  return map.has(right);
}
