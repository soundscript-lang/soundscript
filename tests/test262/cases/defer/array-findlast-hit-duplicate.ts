export function main(): string {
  return ['Shoes', 'Bike', 'Bike', 'Car'].findLast((value) => value === 'Bike') ?? '';
}
