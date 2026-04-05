export function main(): number {
  const key = -1;
  const record = Object.fromEntries([[key, 6]]);
  return record[key];
}
