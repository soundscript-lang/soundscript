export function main(): string {
  return globalThis.Array.from('abc').join(';');
}
