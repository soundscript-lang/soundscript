export function main(): number {
  const key = Symbol('score');
  const alias = key;
  const record = { [key]: 1 };
  record[alias] = 3;
  return record[key];
}
