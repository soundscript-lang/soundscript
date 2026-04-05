export function main(): number {
  const key = Symbol.for('series-0002');
  const record = { [key]: 2 };
  return record[key];
}
