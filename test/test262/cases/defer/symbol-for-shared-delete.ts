export function main(): boolean {
  const key = Symbol.for('shared');
  const record = { [key]: 1 };
  delete record[Symbol.for('shared')];
  return key in record;
}
