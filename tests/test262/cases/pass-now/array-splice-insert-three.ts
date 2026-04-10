export function main(): string {
  const values = [1, 5];
  values.splice(1, 0, 2, 3, 4);
  return values.join('');
}
