export function main(): number {
  return Array.from('𠮷a𠮷b𠮷'.matchAll(/(?:)/gu)).length;
}
