export function main(): number {
  const values = [1, 2, 3, 4, 5, 6];
  return values.splice(1, 5).length;
}
