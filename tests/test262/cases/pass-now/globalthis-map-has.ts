export function main(): boolean {
  return new globalThis.Map([['left', 1]]).has('left');
}
