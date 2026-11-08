/** Text spoken into the field goes after what is there, a space between. */
export function withDictation(current: string, text: string): string {
  const spoken = text.trim();
  if (!spoken) return current;
  if (!current || /\s$/.test(current)) return current + spoken;
  return `${current} ${spoken}`;
}
