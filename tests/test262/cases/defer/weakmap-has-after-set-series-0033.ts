export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 33);
  map.set(right, 34);
  return map.has(right);
}
