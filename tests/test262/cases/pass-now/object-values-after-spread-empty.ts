export function main(): number {
  const target = { ...{}, left: 1 };
  return Object.values(target).length;
}
