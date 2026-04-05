export function main(): number {
  const key = Symbol.for('series-0027');
  const record = { [key]: 27 };
  return record[key];
}
