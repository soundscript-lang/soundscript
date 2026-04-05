export function main(): number {
  const key = 'left';
  const record = { ...{ [key]: 5 } };
  return Object.keys(record).length;
}
