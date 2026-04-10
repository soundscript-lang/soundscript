export function main(): number {
  const value = 41;
  const makeIncrementer = () => value + 1;
  return makeIncrementer();
}
