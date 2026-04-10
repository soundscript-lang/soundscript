export function main(): boolean {
  const key = Symbol.for('shared');
  const record = { [key]: 1 };
  return Symbol.for('shared') in record;
}
