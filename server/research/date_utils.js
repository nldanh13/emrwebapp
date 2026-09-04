'use strict';

function strictLocalDate(year, month, day, hour = 0, minute = 0) {
  const values = [year, month, day, hour, minute];
  if (!values.every(Number.isInteger)) return null;
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const d = new Date(year, month - 1, day, hour, minute);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day || d.getHours() !== hour || d.getMinutes() !== minute) return null;
  return d;
}

module.exports = { strictLocalDate };
