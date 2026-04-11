export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 28);
  map.set(right, 29);
  return map.has(right);
}
