export function main(): number {
  const key = Symbol.for('series-0023');
  const record = { [key]: 23 };
  return record[key];
}
