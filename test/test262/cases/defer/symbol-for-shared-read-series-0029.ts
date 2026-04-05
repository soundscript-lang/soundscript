export function main(): number {
  const key = Symbol.for('series-0029');
  const record = { [key]: 29 };
  return record[key];
}
