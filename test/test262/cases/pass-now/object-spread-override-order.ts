export function main(): number {
  const record = { ...{ left: 1, right: 2 }, ...{ left: 3 }, tail: 4 };
  return record.left * 100 + record.right * 10 + record.tail;
}
