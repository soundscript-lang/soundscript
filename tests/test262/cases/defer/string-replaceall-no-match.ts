export function main(): string {
  function replaceValue(): never {
    throw new Error('replaceValue should not be called');
  }

  return 'a'.replaceAll('b', replaceValue);
}
