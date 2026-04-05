export function main(): number {
  const key: string = 'left';
  const record = { left: 1, ...{ [key]: 2 }, right: 3 };
  return record.left * 10 + record.right;
}
