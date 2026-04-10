export function main(): number {
  const key = Symbol.for('series-0012');
  const record = { [key]: 12 };
  return record[key];
}
