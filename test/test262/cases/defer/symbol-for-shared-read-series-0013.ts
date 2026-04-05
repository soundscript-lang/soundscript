export function main(): number {
  const key = Symbol.for('series-0013');
  const record = { [key]: 13 };
  return record[key];
}
