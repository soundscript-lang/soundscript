export function main(): number {
  const target = { value: 15 };
  const ref = new WeakRef(target);
  return ref.deref()?.value ?? -1;
}
