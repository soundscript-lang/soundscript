export function main(): number {
  const key = Symbol('token');
  const record = Object.assign({}, { [key]: 11 });
  return record[key];
}
