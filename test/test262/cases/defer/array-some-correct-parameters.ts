export function main(): boolean {
  function callbackfn(value: number, index: number, obj: number[]): boolean {
    return obj[index] !== value;
  }

  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].some(callbackfn);
}
