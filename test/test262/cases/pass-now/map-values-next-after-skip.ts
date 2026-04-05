export function main(left: number, right: number): number {
  const iterator = new Map([
    ['left', left],
    ['right', right],
    ['tail', left + right],
  ]).values();
  iterator.next();
  iterator.next();
  return iterator.next().value ?? 0;
}
