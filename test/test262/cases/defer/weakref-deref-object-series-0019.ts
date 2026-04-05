export function main(): number {
  const target = { value: 19 };
  const ref = new WeakRef(target);
  return ref.deref()?.value ?? -1;
}
