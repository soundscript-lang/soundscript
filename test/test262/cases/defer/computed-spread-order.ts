export function main(): string {
  const left = 'b';
  const right = 'a';
  const record = { ...{ [left]: 1 }, ...{ [right]: 2 } };
  return Object.keys(record).join(';');
}
