export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 0);
  map.set(right, 1);
  map.delete(left);
  return map.has(right);
}
