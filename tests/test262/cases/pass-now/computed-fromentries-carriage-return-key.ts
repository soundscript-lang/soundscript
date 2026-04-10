export function main(): number {
  const key = '\r';
  const record = Object.fromEntries([[key, 3]]);
  return record[key];
}
