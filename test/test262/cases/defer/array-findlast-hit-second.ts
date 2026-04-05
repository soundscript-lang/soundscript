export function main(): string {
  return ['Shoes', 'Bike'].findLast((value) => value === 'Shoes') ?? '';
}
