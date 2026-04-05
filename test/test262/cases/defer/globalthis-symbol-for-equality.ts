export function main(): boolean {
  return globalThis.Symbol.for('shared') === Symbol.for('shared');
}
