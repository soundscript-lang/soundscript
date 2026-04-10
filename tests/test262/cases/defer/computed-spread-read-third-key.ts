export function main(): number {
  const left = 'left';
  const middle = 'middle';
  const right = 'right';
  const record = { ...{ [left]: 1 }, ...{ [middle]: 2 }, ...{ [right]: 3 } };
  return record[right];
}
