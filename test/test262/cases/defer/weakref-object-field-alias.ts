export function main(): boolean {
  const target = { value: 1 };
  const holder = { inner: new WeakRef(target) };
  const alias = holder;
  return alias.inner.deref() === target;
}
