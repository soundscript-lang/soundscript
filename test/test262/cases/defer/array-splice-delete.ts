export function main(): number {
  const values = [1, 2, 3, 4];
  values.splice(1, 2);
  return values.length;
}
