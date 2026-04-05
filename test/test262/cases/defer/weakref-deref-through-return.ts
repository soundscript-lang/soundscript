export function main(): boolean {
  const target = { value: 1 };
  function makeRef(value: object): WeakRef<object> {
    return new WeakRef(value);
  }
  return makeRef(target).deref() === target;
}
