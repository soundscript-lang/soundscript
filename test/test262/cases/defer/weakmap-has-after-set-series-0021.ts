export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 21);
  map.set(right, 22);
  return map.has(right);
}
