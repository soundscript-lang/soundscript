export function main(): number {
  const key = 'left';
  const record = Object.fromEntries([[key, 8]]);
  return Object.values(record).length;
}
