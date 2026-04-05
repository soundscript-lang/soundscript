export function main(left: number, right: number): number {
  const iterator = new Map([
    ['left', left],
    ['right', right],
    ['tail', left + right],
  ]).entries();
  iterator.next();
  const second = iterator.next();
  return second.done ? 0 : second.value[0].length + second.value[1];
}
