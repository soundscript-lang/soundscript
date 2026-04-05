export function main(): boolean {
  const target = { value: 1 };
  const holder = { refs: [new WeakRef(target)] };
  return holder.refs[0].deref() === target;
}
