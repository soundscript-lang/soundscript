export function main(): boolean {
  const target = { value: 1 };
  const ref = new WeakRef(target);
  return ref.deref() === target;
}
