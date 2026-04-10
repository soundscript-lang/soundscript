export function main(left: number, right: number): number {
  const iterator = [left, right].keys();
  const first = iterator.next();
  const second = iterator.next();
  return (first.done ? 0 : first.value) + (second.done ? 0 : second.value);
}
