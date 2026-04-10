export function main(): number {
  const key = Symbol('token');
  const record = { 1: 4, [key]: 5 };
  return record[1] + record[key];
}
