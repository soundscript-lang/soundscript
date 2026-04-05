export function main(): number {
  const key = Symbol('score');
  const alias = key;
  const record = { [key]: 7 };
  return record[alias];
}
