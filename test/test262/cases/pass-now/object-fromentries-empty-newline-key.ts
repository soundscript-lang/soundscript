export function main(): number {
  const target = Object.fromEntries([
    ['\n', 1],
  ]);
  return Object.values(target).length;
}
