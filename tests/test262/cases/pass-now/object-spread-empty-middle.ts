export function main(): number {
  const target = { left: 1, ...{}, middle: 2, ...{}, right: 3 };
  return Object.keys(target).length;
}
