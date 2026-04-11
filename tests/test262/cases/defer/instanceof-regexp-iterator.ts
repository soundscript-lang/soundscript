export function main(): boolean {
  const value = /a/.exec('a');
  return value instanceof Array;
}
