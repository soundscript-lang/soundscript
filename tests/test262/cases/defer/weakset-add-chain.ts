export function main(): boolean {
  const values = new WeakSet<object>();
  const left = {};
  const right = {};
  return values.add(left).add(right) === values;
}
