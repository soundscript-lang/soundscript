export function main(): number {
  const key = Symbol.for('series-0016');
  const record = { [key]: 16 };
  return record[key];
}
