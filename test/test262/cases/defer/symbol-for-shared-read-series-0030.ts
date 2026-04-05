export function main(): number {
  const key = Symbol.for('series-0030');
  const record = { [key]: 30 };
  return record[key];
}
