export function main(): string {
  const values = [1, 2, 3];
  values.splice(2, 1, 9, 8);
  return values.join('');
}
