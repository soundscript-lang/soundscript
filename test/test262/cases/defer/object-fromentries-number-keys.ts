export function main(): string {
  const object = Object.fromEntries([
    [1, 1],
    [2, 2],
  ]);
  return Object.getOwnPropertyNames(object).join(',');
}
