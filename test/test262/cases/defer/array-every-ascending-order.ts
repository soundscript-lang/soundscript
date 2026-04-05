export function main(): readonly (boolean | number)[] {
  const values = [0, 1, 2, 3, 4, 5];
  let lastIndex = 0;
  let called = 0;

  function callbackfn(_value: number, index: number): boolean {
    called += 1;
    if (lastIndex !== index) {
      return false;
    }
    lastIndex += 1;
    return true;
  }

  return [values.every(callbackfn), called];
}
