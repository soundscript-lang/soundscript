export function main(): string {
  return 'a1b1c'.replaceAll(1n as any, 'X');
}
