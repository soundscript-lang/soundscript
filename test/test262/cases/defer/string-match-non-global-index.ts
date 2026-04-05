export function main(): number {
  const re = /([\d]{5})([-\ ]?[\d]{4})?$/;
  re.lastIndex = 0;
  return 'Boston, MA 02134'.match(re)?.index ?? -1;
}
