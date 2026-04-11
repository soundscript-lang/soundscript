export function main(): boolean {
  const first = { value: 1 };
  const second = { value: 2 };
  function pair(left: object, right: object): WeakRef<object>[] {
    return [new WeakRef(left), new WeakRef(right)];
  }
  return pair(first, second)[1].deref() === second;
}
