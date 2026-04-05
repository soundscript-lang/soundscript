export function main(): string {
  const values = [1, 2];
  values.splice(0, 0, 9);
  return values.join('');
}
