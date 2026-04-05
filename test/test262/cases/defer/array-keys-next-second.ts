export function main(left: number, right: number): number {
  const iterator = [left, right, left + right].keys();
  iterator.next();
  const second = iterator.next();
  return second.done ? -1 : second.value;
}
