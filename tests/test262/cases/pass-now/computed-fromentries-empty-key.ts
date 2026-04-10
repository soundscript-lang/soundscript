export function main(): number {
  const key = '';
  const record = Object.fromEntries([[key, 5]]);
  return record[key];
}
