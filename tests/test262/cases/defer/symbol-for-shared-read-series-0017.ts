export function main(): number {
  const key = Symbol.for('series-0017');
  const record = { [key]: 17 };
  return record[key];
}
