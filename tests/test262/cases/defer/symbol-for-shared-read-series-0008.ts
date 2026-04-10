export function main(): number {
  const key = Symbol.for('series-0008');
  const record = { [key]: 8 };
  return record[key];
}
