export function main(): number {
  const target = { left: 1, right: 2 };
  Object.assign(target, { left: 3, right: 4 });
  return target.left * 100 + target.right;
}
