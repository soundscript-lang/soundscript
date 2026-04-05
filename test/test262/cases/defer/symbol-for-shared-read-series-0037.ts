export function main(): number {
  const key = Symbol.for('series-0037');
  const record = { [key]: 37 };
  return record[key];
}
