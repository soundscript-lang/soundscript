export function main(): string {
  const values = ['10', '2', '1'];
  values.sort((left, right) => Number(left) - Number(right));
  return values.join(',');
}
