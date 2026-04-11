export function main(): number {
  const target = { left: 0, right: 0 };
  const result = Object.assign(target, { left: 1 }, { right: 2 });
  return result.left * 10 + result.right;
}
