export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 6);
  map.set(right, 7);
  return map.has(right);
}
