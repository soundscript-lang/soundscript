export function main(): number {
  const key = 'left';
  const record = { ...{ [key]: 6 } };
  return Object.values(record).length;
}
