export function main(): number {
  const key = Symbol.for('series-0024');
  const record = { [key]: 24 };
  return record[key];
}
