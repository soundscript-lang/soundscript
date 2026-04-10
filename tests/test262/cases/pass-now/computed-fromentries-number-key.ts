export function main(): number {
  const key = 2;
  const record = Object.fromEntries([[key, 5]]);
  return record[key];
}
