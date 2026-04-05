export function main(): number {
  const target = Object.fromEntries([
    ['  ', 1],
    ['   ', 2],
  ]);
  return Object.keys(target).length;
}
