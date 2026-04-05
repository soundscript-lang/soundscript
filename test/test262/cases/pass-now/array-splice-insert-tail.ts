export function main(): string {
  const values = [1, 2];
  values.splice(values.length, 0, 3, 4);
  return values.join('');
}
