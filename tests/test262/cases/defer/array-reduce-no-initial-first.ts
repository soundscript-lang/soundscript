export function main(): [boolean, number] {
  let called = 0;
  let result = false;

  function callbackfn(previousValue: number, currentValue: number, index: number): number {
    called += 1;
    if (index === 1) {
      result = previousValue === 11 && currentValue === 9;
    }

    return previousValue + currentValue;
  }

  [11, 9].reduce(callbackfn);
  return [result, called];
}
