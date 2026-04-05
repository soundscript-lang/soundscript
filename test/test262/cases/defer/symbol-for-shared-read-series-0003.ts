export function main(): number {
  const key = Symbol.for('series-0003');
  const record = { [key]: 3 };
  return record[key];
}
