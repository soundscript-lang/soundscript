export function main(): number {
  return Array.from('a1b1c'.matchAll(1n as any)).length;
}
