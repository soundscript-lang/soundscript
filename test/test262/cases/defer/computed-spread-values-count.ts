export function main(): number {
  const key = 'left';
  const record = { ...{ [key]: 5 } };
  return Object.values(record).length;
}
