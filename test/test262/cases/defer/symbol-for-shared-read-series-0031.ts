export function main(): number {
  const key = Symbol.for('series-0031');
  const record = { [key]: 31 };
  return record[key];
}
