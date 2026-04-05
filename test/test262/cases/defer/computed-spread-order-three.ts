export function main(): string {
  const left = 'c';
  const middle = 'b';
  const right = 'a';
  const record = { ...{ [left]: 1 }, ...{ [middle]: 2 }, ...{ [right]: 3 } };
  return Object.keys(record).join(';');
}
