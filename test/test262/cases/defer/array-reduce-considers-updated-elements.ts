export function main(): number {
  const values = [1, 2, 3, 4, 5];

  function callbackfn(previousValue: number, currentValue: number): number {
    values[3] = -2;
    values[4] = -1;
    return previousValue + currentValue;
  }

  return values.reduce(callbackfn);
}
