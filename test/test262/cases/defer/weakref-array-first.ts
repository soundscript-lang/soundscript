export function main(): boolean {
  const first = { value: 1 };
  const second = { value: 2 };
  const refs = [new WeakRef(first), new WeakRef(second)];
  return refs[0].deref() === first;
}
