export function main(key: string, value: number): string {
  const target = Object.fromEntries([[key, value], ['right', value + 1]]);
  return Object.keys(target).join(',');
}
