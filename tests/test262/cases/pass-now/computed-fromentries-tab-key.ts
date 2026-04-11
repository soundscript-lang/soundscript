export function main(): number {
  const key = '\t';
  const record = Object.fromEntries([[key, 3]]);
  return record[key];
}
