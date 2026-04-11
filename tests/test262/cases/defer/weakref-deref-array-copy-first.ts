export function main(): boolean {
  const first = { value: 1 };
  const second = { value: 2 };
  const refs = [new WeakRef(first), new WeakRef(second)];
  const copy = refs.slice();
  return copy[0].deref() === first;
}
