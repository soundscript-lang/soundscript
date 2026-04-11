export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 23);
  map.set(right, 24);
  return map.has(right);
}
