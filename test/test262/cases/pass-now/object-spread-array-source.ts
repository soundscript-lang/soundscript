export function main(): number {
  const target = { ...['left', 'right'] };
  return Object.keys(target).length;
}
