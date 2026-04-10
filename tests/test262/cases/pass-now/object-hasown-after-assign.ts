export function main(left: number, right: number): boolean {
  const assigned = Object.assign({ left }, { right });
  return Object.hasOwn(assigned, 'right');
}
