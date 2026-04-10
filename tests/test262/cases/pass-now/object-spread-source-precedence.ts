export function main(): number {
  const first = { left: 1, middle: 2 };
  const second = { left: 3 };
  const target = { ...first, ...second };
  return target.left * 10 + target.middle;
}
