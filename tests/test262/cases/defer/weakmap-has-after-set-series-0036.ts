export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 36);
  map.set(right, 37);
  return map.has(right);
}
