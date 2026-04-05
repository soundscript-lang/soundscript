export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 16);
  map.set(right, 17);
  return map.has(right);
}
