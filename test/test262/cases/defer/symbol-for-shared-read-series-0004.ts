export function main(): number {
  const key = Symbol.for('series-0004');
  const record = { [key]: 4 };
  return record[key];
}
