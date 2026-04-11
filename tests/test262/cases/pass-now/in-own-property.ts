type Pair = { left: number; right: number };

export function main(left: number, right: number): boolean {
  const pair: Pair = { left, right };
  return 'left' in pair;
}
