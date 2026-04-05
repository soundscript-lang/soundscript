export function main(): number {
  const key = Symbol('token');
  const record = { ...{ [key]: 6 } };
  return record[key];
}
