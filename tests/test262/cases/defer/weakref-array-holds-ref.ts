export function main(): boolean {
  const target = { value: 1 };
  const refs = [new WeakRef(target)];
  return refs[0].deref() === target;
}
