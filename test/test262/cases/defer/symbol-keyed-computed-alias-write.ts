export function main(): number {
  const key = Symbol('token');
  const alias = key;
  const record = { [key]: 1 };
  record[alias] = 10;
  return record[key];
}
