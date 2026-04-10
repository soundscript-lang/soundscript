export function main(): number {
  const key = 'left';
  const record = Object.fromEntries([[key, 9]]);
  return Object.entries(record).length;
}
