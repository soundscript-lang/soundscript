export function main(): number {
  return new Set([6, 7]).values().next().value ?? 0;
}
