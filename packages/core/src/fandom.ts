/**
 * Display names for AO3 fandom tags.
 *
 * AO3 names fandoms from non-English sources "Original name | English name", e.g.
 * "魔道祖师 - 墨香铜臭 | Módào Zǔshī - Mòxiāng Tóngxiù" or "Мастер и Маргарита | The Master and Margarita".
 * In a reading list that puts the original script first and sorts those groups apart
 * from everything else, so by default we show the part after the "|" when the part
 * before it isn't written in the Latin alphabet. A name the user chose always wins.
 */
const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

export function autoFandomName(name: string): string {
  const i = name.indexOf(' | ');
  if (i < 0) return name;
  const original = name.slice(0, i).trim();
  const english = name.slice(i + 3).trim();
  if (!english || !NON_LATIN.test(original) || NON_LATIN.test(english)) return name;
  return english;
}

export function fandomDisplayName(name: string, renames: Record<string, string> = {}): string {
  const custom = renames[name]?.trim();
  return custom || autoFandomName(name);
}
