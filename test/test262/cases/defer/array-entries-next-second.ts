export function main(left: number, right: number): number {
  const iterator = [left, right, left + right].entries();
  iterator.next();
  const second = iterator.next();
  return second.done ? 0 : second.value[0] * 10 + second.value[1];
}
