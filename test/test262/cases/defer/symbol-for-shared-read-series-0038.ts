export function main(): number {
  const key = Symbol.for('series-0038');
  const record = { [key]: 38 };
  return record[key];
}
