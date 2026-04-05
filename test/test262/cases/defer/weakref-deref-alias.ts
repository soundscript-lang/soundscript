export function main(): boolean {
  const target = { value: 1 };
  const ref = new WeakRef(target);
  const alias = ref;
  return alias.deref() === target;
}
