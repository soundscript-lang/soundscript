export function main(): number {
  const values = [1, 2, 3];
  values.splice(1, 0, 9);
  return values.length;
}
