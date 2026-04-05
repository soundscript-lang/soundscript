export function main(): number {
  const target = { value: 5 };
  const ref = new WeakRef(target);
  return ref.deref()?.value ?? -1;
}
