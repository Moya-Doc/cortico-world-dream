export function localClock(now: number, timezone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

export function sleepCommand(text: string): { kind: 'sleep'; minutes?: number } | { kind: 'wake' } | null {
  const clean = text.trim().replace(/[。！!]+$/u, '');
  if (/^(?:醒来|起床|wake(?: up)?)$/iu.test(clean)) return { kind: 'wake' };
  const match = /^(?:睡觉|睡眠|睡|sleep)(?:\s*([0-9]+|[零一二两三四五六七八九十百]+)\s*(分钟|分|小时|小時|minutes?|mins?|hours?|h))?$/iu.exec(clean);
  if (!match) return null;
  if (!match[1]) return { kind: 'sleep' };
  const raw = match[1];
  const digits = '零一二三四五六七八九';
  let value = 0, digit = 0;
  if (/^\d+$/.test(raw)) value = Number(raw);
  else for (const c of raw.replaceAll('两', '二')) {
    if (c === '十' || c === '百') { value += (digit || 1) * (c === '十' ? 10 : 100); digit = 0; }
    else digit = digits.indexOf(c);
  }
  if (!/^\d+$/.test(raw)) value += digit;
  if (/^(小时|小時|hours?|h)$/iu.test(match[2])) value *= 60;
  return value >= 1 && value <= 1440 ? { kind: 'sleep', minutes: value } : null;
}
