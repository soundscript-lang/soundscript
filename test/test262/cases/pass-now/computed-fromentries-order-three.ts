export function main(): string {
  const left = 'c';
  const middle = 'b';
  const right = 'a';
  const record = Object.fromEntries([[left, 1], [middle, 2], [right, 3]]);
  return Object.keys(record).join(';');
}
