export function main(): number {
  return new globalThis.Map([['left', 1]]).get('left') ?? 0;
}
