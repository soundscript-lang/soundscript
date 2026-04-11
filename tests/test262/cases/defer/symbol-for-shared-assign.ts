export function main(): number {
  const key = Symbol.for('shared');
  const record = Object.assign({}, { [key]: 1 });
  return record[Symbol.for('shared')];
}
