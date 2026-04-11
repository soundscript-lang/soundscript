export function main(): string {
  return ['Shoes', 'Bike', 'Car'].findLast((value) => value !== 'Car') ?? '';
}
