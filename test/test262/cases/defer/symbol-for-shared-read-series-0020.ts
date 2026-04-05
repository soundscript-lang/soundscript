export function main(): number {
  const key = Symbol.for('series-0020');
  const record = { [key]: 20 };
  return record[key];
}
