export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 18);
  map.set(right, 19);
  return map.has(right);
}
