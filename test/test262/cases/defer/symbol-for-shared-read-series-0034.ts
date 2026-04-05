export function main(): number {
  const key = Symbol.for('series-0034');
  const record = { [key]: 34 };
  return record[key];
}
