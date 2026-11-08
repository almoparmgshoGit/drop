export const csvCell = (value: unknown) => {
  const text = String(value ?? '');
  // A leading =, +, - or @ makes spreadsheets run the cell as a formula.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** The byte order mark makes Excel read the Arabic text as UTF-8. */
export const csvFile = (header: string[], rows: unknown[][]) => `﻿${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
