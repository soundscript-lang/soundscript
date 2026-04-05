export function main(): number {
  const key = Symbol.for('series-0011');
  const record = { [key]: 11 };
  return record[key];
}
