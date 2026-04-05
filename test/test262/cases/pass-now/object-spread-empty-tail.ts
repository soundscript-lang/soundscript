export function main(): number {
  const target = { left: 1, ...{}, right: 2, ...{} };
  return Object.keys(target).length;
}
