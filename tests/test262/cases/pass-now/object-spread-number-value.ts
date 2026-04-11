export function main(): number {
  const source = { left: 1, middle: 2 };
  const target = { ...source };
  return target.left + target.middle;
}
