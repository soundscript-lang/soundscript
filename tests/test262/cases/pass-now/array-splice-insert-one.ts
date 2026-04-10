export function main(): string {
  const values = [1, 3];
  values.splice(1, 0, 2);
  return values.join('');
}
