export function main(): number {
  const key = Symbol.for('series-0005');
  const record = { [key]: 5 };
  return record[key];
}
