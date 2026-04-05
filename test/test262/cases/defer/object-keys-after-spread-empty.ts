export function main(): number {
  const target = { ...{}, left: 1 };
  return Object.keys(target).length;
}
