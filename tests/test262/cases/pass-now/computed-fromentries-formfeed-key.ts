export function main(): number {
  const key = '\f';
  const record = Object.fromEntries([[key, 3]]);
  return record[key];
}
