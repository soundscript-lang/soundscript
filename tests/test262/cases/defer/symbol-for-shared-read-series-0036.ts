export function main(): number {
  const key = Symbol.for('series-0036');
  const record = { [key]: 36 };
  return record[key];
}
