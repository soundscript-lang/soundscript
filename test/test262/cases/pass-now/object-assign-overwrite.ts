export function main(): number {
  const target = { left: 1, right: 2 };
  const result = Object.assign(target, { left: 3 }, { right: 4 });
  return result.left * 10 + result.right;
}
