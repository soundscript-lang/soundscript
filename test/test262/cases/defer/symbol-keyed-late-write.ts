export function main(): number {
  const key = Symbol('score');
  const record = {} as { [key: symbol]: number };
  record[key] = 4;
  return record[key];
}
