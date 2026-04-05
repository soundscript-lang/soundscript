export function main(): number {
  const target = { value: 7 };
  const ref = new WeakRef(target);
  return ref.deref()?.value ?? -1;
}
