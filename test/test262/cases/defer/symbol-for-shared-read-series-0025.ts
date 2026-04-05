export function main(): number {
  const key = Symbol.for('series-0025');
  const record = { [key]: 25 };
  return record[key];
}
