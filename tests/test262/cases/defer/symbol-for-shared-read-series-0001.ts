export function main(): number {
  const key = Symbol.for('series-0001');
  const record = { [key]: 1 };
  return record[key];
}
