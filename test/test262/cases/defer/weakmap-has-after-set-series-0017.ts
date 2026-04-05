export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 17);
  map.set(right, 18);
  return map.has(right);
}
