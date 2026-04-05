export function main(): boolean {
  const value = new Map([['left', 1]]).entries();
  return value instanceof Object;
}
