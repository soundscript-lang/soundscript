export function main(): number {
  const key = Symbol.for('series-0014');
  const record = { [key]: 14 };
  return record[key];
}
