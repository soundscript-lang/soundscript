export function main(): number {
  const values = [1, 4];
  values.splice(1, 0, 2, 3);
  return values[0] * 1000 + values[1] * 100 + values[2] * 10 + values[3];
}
