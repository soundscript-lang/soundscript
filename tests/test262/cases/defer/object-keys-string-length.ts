export function main(text: string): string {
  const boxed = new String(text);
  return Object.keys(boxed).join(',');
}
