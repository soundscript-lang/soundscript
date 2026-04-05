export function main(): boolean {
  const target = { value: 1 };
  const box = { ref: new WeakRef(target) };
  return box.ref.deref() === target;
}
