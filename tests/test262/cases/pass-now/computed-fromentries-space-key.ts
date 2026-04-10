export function main(): number {
  const key = ' ';
  const record = Object.fromEntries([[key, 4]]);
  return record[key];
}
