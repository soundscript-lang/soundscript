export function main(): string {
  const tab = '\t';
  const bee = 'b';
  const record = { ...{ [bee]: 1 }, ...{ [tab]: 2 } };
  return Object.keys(record).join(';');
}
