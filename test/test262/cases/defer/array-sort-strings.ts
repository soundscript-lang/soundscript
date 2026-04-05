export function main(left: string, right: string): string[] {
  const values = [right, left, `${left}${right}`];
  values.sort();
  return values;
}
