export function main(): string[] {
  return Array.from(new Set(['a', 'b']), (value) => value.toUpperCase());
}
