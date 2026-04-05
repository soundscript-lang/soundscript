export function main(): number {
  const key = 'left';
  const alias = key;
  const record = Object.fromEntries([[key, 7]]);
  return record[alias];
}
