export function main(key: string, value: number): number {
  const target = Object.fromEntries([[key, value], ['right', value + 1]]);
  return (target as Record<string, number>)[key] * 10 + (target as Record<string, number>).right;
}
