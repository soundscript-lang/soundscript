export function main(): number {
  const key = Symbol.for('series-0039');
  const record = { [key]: 39 };
  return record[key];
}
