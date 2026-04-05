export function main(): number {
  const key = Symbol.for('series-0028');
  const record = { [key]: 28 };
  return record[key];
}
