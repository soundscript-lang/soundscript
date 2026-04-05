export function main(): number {
  const value = 41;
  const outer = () => () => value;
  return outer()();
}
