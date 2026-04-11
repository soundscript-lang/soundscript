export function main(): string {
  const values = ['c', 'a', 'b'];
  values.sort(() => 0);
  return values.join('');
}
