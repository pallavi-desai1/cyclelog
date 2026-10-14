// Local calendar parts, never toISOString(): an evening in US Central would
// otherwise date today as tomorrow and report the cycle day one too high.
export function localToday(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
