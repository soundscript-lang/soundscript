export function main(): number {
  const key = Symbol.for('series-0018');
  const record = { [key]: 18 };
  return record[key];
}
