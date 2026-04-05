export function main(): number {
  return Array.from('a'.matchAll(undefined))[0]?.index ?? -1;
}
