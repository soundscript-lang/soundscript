export function main(): number {
  const values = [1, 2, 3];
  return values.splice(0, values.length).length;
}
