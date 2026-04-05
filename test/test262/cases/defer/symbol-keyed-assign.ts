export function main(): number {
  const key = Symbol('token');
  const record = Object.assign({}, { [key]: 5 });
  return record[key];
}
