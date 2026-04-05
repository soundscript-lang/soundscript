export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 26);
  map.set(right, 27);
  return map.has(right);
}
