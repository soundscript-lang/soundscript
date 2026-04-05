export function main(): boolean {
  const target = { value: 1 };
  return new WeakRef(target).deref() === target;
}
