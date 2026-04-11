export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 25);
  map.set(right, 26);
  return map.has(right);
}
