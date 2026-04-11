export function main(): boolean {
  const target = { value: 1 };
  const make = (value: object): WeakRef<object> => new WeakRef(value);
  return make(target).deref() === target;
}
