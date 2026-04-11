export function main(): number {
  const values = [1, 2, 3, 4];
  values.splice(1, 2, 9, 8);
  return values[0] * 1000 + values[1] * 100 + values[2] * 10 + values[3];
}
