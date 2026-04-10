export function main(): number {
  const key = Symbol('token');
  const record = Object.assign({}, { [key]: 1 }, { [key]: 2 });
  return record[key];
}
