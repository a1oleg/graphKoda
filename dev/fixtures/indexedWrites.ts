export function writes(items: number[], record: Record<string, number>, index: number, key: string) {
  const read = items[index];
  items[index] = read;
  record[key] = read;
  items[index] += 1;
  return items[index];
}
