export function main(): string {
  const values = [1, 2, 3, 4];
  values.splice(1, 2, 8, 9);
  return values.join('');
}
