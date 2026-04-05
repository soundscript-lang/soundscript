export function main(): boolean {
  const target = { value: 1 };
  let ref = new WeakRef(target);
  ref = ref;
  return ref.deref() === target;
}
