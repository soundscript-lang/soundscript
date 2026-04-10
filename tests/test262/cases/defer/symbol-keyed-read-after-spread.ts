export function main(): number {
  const key = Symbol('token');
  const record = { ...{ [key]: 4 } };
  return record[key];
}
