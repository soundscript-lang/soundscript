export function main(): number {
  const key = Symbol.for('series-0033');
  const record = { [key]: 33 };
  return record[key];
}
