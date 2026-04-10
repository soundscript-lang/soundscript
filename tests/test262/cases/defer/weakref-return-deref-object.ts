export function main(): boolean {
  const target = { nested: { value: 1 } };
  const make = (value: { nested: object }): WeakRef<object> => new WeakRef(value.nested);
  return make(target).deref() === target.nested;
}
