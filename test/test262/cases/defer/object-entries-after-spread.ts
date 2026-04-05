export function main(): string {
  const record = { ...{ left: 1 }, ...{ right: 2 } };
  return Object.entries(record).map(([key, value]) => `${key}${value}`).join(',');
}
