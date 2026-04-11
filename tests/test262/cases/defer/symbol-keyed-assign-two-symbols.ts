export function main(): number {
  const left = Symbol('left');
  const right = Symbol('right');
  const record = Object.assign({}, { [left]: 1 }, { [right]: 2 });
  return record[left] + record[right];
}
