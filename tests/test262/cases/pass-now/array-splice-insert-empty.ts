export function main(): number {
  const values = [1, 2];
  return values.splice(1, 0).length;
}
