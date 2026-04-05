export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 4);
  map.set(right, 5);
  return map.has(right);
}
