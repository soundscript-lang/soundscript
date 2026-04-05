export function main(): number {
  return '123456abcde7890'.match(/\d{1}/g)?.length ?? 0;
}
