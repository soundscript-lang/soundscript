export function main(): string {
  const values = [3, , 1, 2];
  values.sort();
  return values.join(',');
}
