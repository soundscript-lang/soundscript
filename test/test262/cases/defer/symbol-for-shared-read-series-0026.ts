export function main(): number {
  const key = Symbol.for('series-0026');
  const record = { [key]: 26 };
  return record[key];
}
