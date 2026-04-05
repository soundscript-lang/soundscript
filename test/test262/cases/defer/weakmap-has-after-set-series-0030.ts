export function main(): boolean {
  const left = {};
  const right = {};
  const map = new WeakMap<object, number>();
  map.set(left, 30);
  map.set(right, 31);
  return map.has(right);
}
