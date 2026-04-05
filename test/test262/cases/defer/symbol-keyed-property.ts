export function main(): boolean {
  const key = Symbol();
  const record = Object.fromEntries([[key, 'value']]);
  return record[key] === 'value';
}
