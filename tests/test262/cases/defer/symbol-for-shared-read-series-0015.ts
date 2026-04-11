export function main(): number {
  const key = Symbol.for('series-0015');
  const record = { [key]: 15 };
  return record[key];
}
