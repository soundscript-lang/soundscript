export function main(): string {
  const record = Object.fromEntries([
    [' key', 1],
  ]);
  return Object.keys(record)[0];
}
