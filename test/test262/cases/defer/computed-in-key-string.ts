type Pair = { left: number; right: number };

export function main(flag: boolean, left: number, right: number): boolean {
  const pair: Pair = { left, right };
  const key = flag ? 'left' : 'right';
  return key in pair;
}
