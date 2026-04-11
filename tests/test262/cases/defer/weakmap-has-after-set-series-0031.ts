export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 31);
  map.set(right, 32);
  return map.has(right);
}
