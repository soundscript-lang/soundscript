export function main(left: number, right: number): number {
  const assigned = Object.assign({ left }, { right });
  return Object.entries(assigned).length;
}
