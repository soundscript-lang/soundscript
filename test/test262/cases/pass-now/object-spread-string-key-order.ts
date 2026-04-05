export function main(): string {
  const target = { ...{ zebra: 1 }, ...{ alpha: 2 }, middle: 3 };
  return Object.keys(target).join(',');
}
