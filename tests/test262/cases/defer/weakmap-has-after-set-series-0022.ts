export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 22);
  map.set(right, 23);
  return map.has(right);
}
