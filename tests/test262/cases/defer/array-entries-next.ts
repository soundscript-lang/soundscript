export function main(left: number, right: number): number {
  const iterator = [left, right].entries();
  const first = iterator.next();
  return first.done ? 0 : first.value[0] * 10 + first.value[1];
}
