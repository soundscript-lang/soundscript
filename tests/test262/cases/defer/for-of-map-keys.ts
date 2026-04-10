export function main(): string {
  let text = '';
  for (
    const [key] of new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
  ) {
    text += key;
  }
  return text;
}
