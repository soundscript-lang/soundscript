export function main(): number {
  const key = Symbol.for('series-0009');
  const record = { [key]: 9 };
  return record[key];
}
