export function main(): boolean {
  const target = { value: 1 };
  const holder = { ref: new WeakRef(target) };
  return holder.ref.deref() === target;
}
