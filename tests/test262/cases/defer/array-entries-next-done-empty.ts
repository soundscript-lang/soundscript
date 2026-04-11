export function main(): boolean {
  const iterator = [].entries();
  iterator.next();
  return iterator.next().done ?? false;
}
