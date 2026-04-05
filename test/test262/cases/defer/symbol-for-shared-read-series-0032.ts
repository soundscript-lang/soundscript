export function main(): number {
  const key = Symbol.for('series-0032');
  const record = { [key]: 32 };
  return record[key];
}
