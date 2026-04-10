export function main(): string {
  const values = [1, 7];
  values.splice(1, 0, 2, 3, 4, 5, 6);
  return values.join('');
}
