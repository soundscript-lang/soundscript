export function main(): number {
  return 'Boston, Mass. 02134'.match(/([\d]{5})([-\ ]?[\d]{4})?$/)?.length ?? 0;
}
