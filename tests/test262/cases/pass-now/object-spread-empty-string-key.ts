export function main(): string {
  const target = { ...{ '': 1 }, middle: 2 };
  return Object.keys(target).join(',');
}
