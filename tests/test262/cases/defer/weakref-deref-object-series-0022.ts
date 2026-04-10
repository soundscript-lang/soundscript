export function main(): number {
  const target = { value: 22 };
  const ref = new WeakRef(target);
  return ref.deref()?.value ?? -1;
}
