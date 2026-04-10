export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 15);
  map.set(right, 16);
  return map.has(right);
}
