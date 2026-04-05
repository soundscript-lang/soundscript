export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 5);
  map.set(right, 6);
  return map.has(right);
}
