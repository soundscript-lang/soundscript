export function main(key: string, value: number): string {
  const source = { [key]: value, right: value + 1 };
  const target = Object.assign({}, source);
  return Object.entries(target)
    .map(([entryKey, entryValue]) => `${entryKey}:${entryValue}`)
    .join(',');
}
