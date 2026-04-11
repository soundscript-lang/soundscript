type NumberLikeBag = { [key: string]: number; [key: number]: number };

export function main(value: number): number {
  const bag: NumberLikeBag = { 1: 3, 2: 4 };
  bag['1'] = value;
  return bag[1] * 100 + bag['1'] * 10 + bag[2];
}
