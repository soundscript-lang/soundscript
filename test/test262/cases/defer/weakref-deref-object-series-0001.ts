export function main(): number {
  const target = { value: 1 };
  const ref = new WeakRef(target);
  return ref.deref()?.value ?? -1;
}
