type Scores = { 1: number; 2: number };

export function main(flag: boolean, left: number, right: number): boolean {
  const scores: Scores = { 1: left, 2: right };
  const key = flag ? 1 : 2;
  return key in scores;
}
