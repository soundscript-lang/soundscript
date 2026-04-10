export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export default 19; export const box = { value: 1 };'
  );
  return mod.default + mod.box.value;
}
