export function main(left: number, right: number): number {
  const values = [right];
  values.unshift(left);
  return values.length;
}
