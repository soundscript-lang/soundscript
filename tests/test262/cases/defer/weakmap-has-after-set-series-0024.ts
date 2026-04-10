export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 24);
  map.set(right, 25);
  return map.has(right);
}
