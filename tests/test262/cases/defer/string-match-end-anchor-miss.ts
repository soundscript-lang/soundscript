export function main(): string | undefined {
  return 'Boston, Mass. 02134'.match(/([\d]{5})([-\ ]?[\d]{4})?$/)?.[2];
}
