export function main(): string {
  const values = [1, 4];
  values.splice(1, 0, 2, 3);
  return values.join('');
}
