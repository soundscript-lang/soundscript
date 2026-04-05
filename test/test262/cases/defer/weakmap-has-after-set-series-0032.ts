export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 32);
  map.set(right, 33);
  return map.has(right);
}
