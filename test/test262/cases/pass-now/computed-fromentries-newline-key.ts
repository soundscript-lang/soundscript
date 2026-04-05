export function main(): number {
  const key = '\n';
  const record = Object.fromEntries([[key, 3]]);
  return record[key];
}
