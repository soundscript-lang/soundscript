export function main(): string | null {
  const re = /([\d]{5})([-\ ]?[\d]{4})?$/;
  const text = 'Boston, MA 02134';
  re.lastIndex = text.length;
  const matched = text.match(re);
  return matched ? matched[0] : null;
}
