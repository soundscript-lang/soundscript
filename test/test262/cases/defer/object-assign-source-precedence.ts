export function main(): number {
  const target = { left: 1 };
  Object.assign(target, { left: 2, right: 3 }, { left: 4 });
  return target.left * 10 + target.right;
}
