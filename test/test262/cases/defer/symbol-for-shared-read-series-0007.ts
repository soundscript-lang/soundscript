export function main(): number {
  const key = Symbol.for('series-0007');
  const record = { [key]: 7 };
  return record[key];
}
