export function main(): boolean {
  const key = Symbol('token');
  const record = { ...{ [key]: 1 } };
  delete record[key];
  return key in record;
}
