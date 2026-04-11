export function main(): number {
  const record = { ...{ left: 1 }, ...{ right: 2 } };
  return Object.values(record).reduce((sum, value) => sum + value, 0);
}
