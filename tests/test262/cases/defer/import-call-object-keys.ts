export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export const left=1; export const right=2; export default 3;'
  );
  return Object.keys(mod).length;
}
