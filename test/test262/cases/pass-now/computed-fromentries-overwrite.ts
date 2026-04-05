export function main(): number {
  const key = 'left';
  const record = Object.fromEntries([[key, 1], [key, 6]]);
  return record[key];
}
