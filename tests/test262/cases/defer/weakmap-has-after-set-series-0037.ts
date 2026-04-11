export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 37);
  map.set(right, 38);
  return map.has(right);
}
