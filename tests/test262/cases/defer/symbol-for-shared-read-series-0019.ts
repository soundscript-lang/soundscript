export function main(): number {
  const key = Symbol.for('series-0019');
  const record = { [key]: 19 };
  return record[key];
}
