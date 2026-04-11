export function main(): string {
  const source = { left: 1, right: 2 };
  const target = { ...source };
  return Object.entries(target)
    .map(([entryKey, entryValue]) => `${entryKey}:${entryValue}`)
    .join(',');
}
