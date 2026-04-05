export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 29);
  map.set(right, 30);
  return map.has(right);
}
