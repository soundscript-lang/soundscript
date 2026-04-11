export function main(): number {
  const key = 'left';
  const record = Object.fromEntries([[key, 6]]);
  return Object.keys(record).length;
}
