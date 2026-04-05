export function main(left: number, right: number): number {
  const iterator = [left, right, left + right].values();
  iterator.next();
  const second = iterator.next();
  const third = iterator.next();
  return (second.done ? 0 : second.value) * 10 + (third.done ? 0 : third.value);
}
