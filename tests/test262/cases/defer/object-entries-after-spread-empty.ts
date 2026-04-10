export function main(): number {
  const target = { ...{}, left: 1 };
  return Object.entries(target).length;
}
