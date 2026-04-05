export function main(): string {
  const record = { ...{ left: 1, right: 2 }, ...{ left: 3 } };
  return Object.keys(record).join(':');
}
