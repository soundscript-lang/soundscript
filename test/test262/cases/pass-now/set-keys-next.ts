export function main(): number {
  return new Set([4, 5]).keys().next().value ?? 0;
}
