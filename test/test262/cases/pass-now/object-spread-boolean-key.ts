export function main(): string {
  const source = { [String(true)]: 1 };
  const target = { ...source, false: 2 };
  return Object.keys(target).join(',');
}
