export function main(): number {
  const key = Symbol('score');
  const record = { [key]: 1 };
  record[key] = 2;
  return record[key];
}
