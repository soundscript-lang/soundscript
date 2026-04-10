export async function main(): Promise<number> {
  const mod = await import(
    'data:text/javascript,export default 28; export const box = { value: 2 };'
  );
  return mod.default + mod.box.value;
}
