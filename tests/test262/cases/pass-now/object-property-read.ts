type Pair = { left: number; right: number };

export function main(left: number, right: number): number {
  const pair: Pair = { left, right };
  return pair.left * 10 + pair.right;
}
