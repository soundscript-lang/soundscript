export function main(): string {
  const key = Symbol.for('shared');
  const record = { plain: 'x', [key]: 'y' };
  return `${Object.values(record).length}:${record[key]}`;
}
