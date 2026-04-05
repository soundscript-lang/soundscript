export function main(): string {
  const values = [3, 4];
  values.splice(0, 0, 1, 2);
  return values.join('');
}
