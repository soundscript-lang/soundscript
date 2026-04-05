export function main(): string | null {
  const matched = 'Boston, Mass. 02134'.match(/([\d]{5})([-\ ]?[\d]{4})?$/);
  return matched ? (matched.input ?? null) : null;
}
