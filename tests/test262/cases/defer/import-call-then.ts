export function main(): Promise<number> {
  return import('data:text/javascript,export const value=4;').then((mod) => mod.value);
}
