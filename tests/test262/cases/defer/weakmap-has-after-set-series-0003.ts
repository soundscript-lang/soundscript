export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 3);
  map.set(right, 4);
  return map.has(right);
}
