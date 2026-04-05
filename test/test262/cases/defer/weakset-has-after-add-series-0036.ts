export function main(): boolean {
  const left = {};
  const right = {};
  const set = new WeakSet<object>();
  set.add(left);
  set.add(right);
  return set.has(right);
}
