export function main(text: string): number | undefined {
  return text.match(/a+/)?.index;
}
