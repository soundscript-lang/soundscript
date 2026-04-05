export function main(): number {
  const key = Symbol.for('series-0010');
  const record = { [key]: 10 };
  return record[key];
}
