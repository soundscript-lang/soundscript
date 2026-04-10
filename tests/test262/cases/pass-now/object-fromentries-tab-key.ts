export function main(): string {
  const target = Object.fromEntries([
    ['\t', 1],
  ]);
  return Object.keys(target)[0];
}
