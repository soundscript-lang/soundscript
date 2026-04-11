export function main(): boolean {
  const iterator = [].entries();
  return iterator.next().done ?? false;
}
