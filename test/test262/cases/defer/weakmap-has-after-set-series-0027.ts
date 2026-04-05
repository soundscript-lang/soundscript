export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 27);
  map.set(right, 28);
  return map.has(right);
}
