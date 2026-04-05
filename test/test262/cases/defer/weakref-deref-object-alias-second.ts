export function main(): boolean {
  const first = { value: 1 };
  const second = { value: 2 };
  const holder = { refs: [new WeakRef(first), new WeakRef(second)] };
  const alias = holder;
  return alias.refs[1].deref() === second;
}
