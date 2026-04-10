export function main(): boolean {
  const canonical = globalThis.Symbol.for('s');
  return typeof canonical === 'symbol' && canonical === Symbol.for('s');
}
