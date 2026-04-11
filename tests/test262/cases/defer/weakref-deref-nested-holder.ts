export function main(): boolean {
  const target = { value: 1 };
  const holder = { inner: { ref: new WeakRef(target) } };
  return holder.inner.ref.deref() === target;
}
