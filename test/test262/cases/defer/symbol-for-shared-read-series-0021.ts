export function main(): number {
  const key = Symbol.for('series-0021');
  const record = { [key]: 21 };
  return record[key];
}
