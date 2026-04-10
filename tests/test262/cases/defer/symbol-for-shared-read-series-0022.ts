export function main(): number {
  const key = Symbol.for('series-0022');
  const record = { [key]: 22 };
  return record[key];
}
