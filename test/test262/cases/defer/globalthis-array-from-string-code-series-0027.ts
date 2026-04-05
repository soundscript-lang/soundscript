export function main(): number {
  return globalThis.Array.from('AB')[1].charCodeAt(0);
}
