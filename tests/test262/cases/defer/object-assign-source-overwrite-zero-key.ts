export function main(): string {
  const source = { 0: 'right' };
  const target = Object.assign({ 0: 'left' }, source);
  return target[0];
}
