export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 19);
  map.set(right, 20);
  return map.has(right);
}
