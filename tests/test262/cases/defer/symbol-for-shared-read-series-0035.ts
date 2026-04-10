export function main(): number {
  const key = Symbol.for('series-0035');
  const record = { [key]: 35 };
  return record[key];
}
