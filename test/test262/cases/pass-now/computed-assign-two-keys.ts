export function main(): number {
  const left = 'left';
  const right = 'right';
  const record = Object.assign({}, { [left]: 1 }, { [right]: 2 });
  return record[left] + record[right];
}
