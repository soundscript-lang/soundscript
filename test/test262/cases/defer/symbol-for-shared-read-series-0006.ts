export function main(): number {
  const key = Symbol.for('series-0006');
  const record = { [key]: 6 };
  return record[key];
}
