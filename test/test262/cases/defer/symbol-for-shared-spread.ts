export function main(): number {
  const key = Symbol.for('shared');
  const record = { ...{ [key]: 2 } };
  return record[Symbol.for('shared')];
}
