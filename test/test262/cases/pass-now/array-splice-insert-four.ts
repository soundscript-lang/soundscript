export function main(): string {
  const values = [1, 6];
  values.splice(1, 0, 2, 3, 4, 5);
  return values.join('');
}
