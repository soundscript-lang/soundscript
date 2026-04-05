export function main(): string {
  const source = { left: 1, right: 2 };
  const record = Object.assign({}, { ...source });
  return Object.keys(record).join(',');
}
