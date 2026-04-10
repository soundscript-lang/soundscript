export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 20);
  map.set(right, 21);
  return map.has(right);
}
