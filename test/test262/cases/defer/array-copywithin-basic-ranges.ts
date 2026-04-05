export function main(): number[][] {
  return [
    [0, 1, 2, 3].copyWithin(0, 0, 0),
    [0, 1, 2, 3].copyWithin(0, 0, 2),
    [0, 1, 2, 3].copyWithin(0, 1, 2),
    [0, 1, 2, 3].copyWithin(1, 0, 2),
    [0, 1, 2, 3, 4, 5].copyWithin(1, 3, 5),
  ];
}
