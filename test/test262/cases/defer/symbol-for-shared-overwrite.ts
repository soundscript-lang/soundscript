export function main(): number {
  const key = Symbol.for('shared-token');
  const record = { [key]: 1 };
  record[Symbol.for('shared-token')] = 2;
  return record[key];
}
