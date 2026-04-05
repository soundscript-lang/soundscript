export function main(): number {
  const target = Object.fromEntries([
    ['\t', 1],
  ]);
  return Object.keys(target).length;
}
