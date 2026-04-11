export function main(): number {
  const record = { ...['a', 'b'] };
  return Object.keys(record).length;
}
