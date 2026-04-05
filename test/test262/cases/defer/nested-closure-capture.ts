export function main(): number {
  const value = 41;
  const outer = () => () => value + 1;
  return outer()();
}
