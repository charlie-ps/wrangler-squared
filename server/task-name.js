const key = (s) => String(s).trim().toLowerCase();

// Case-insensitive, so "Sign-in" beside an existing "sign-in" becomes "Sign-in 2".
export function uniqueTaskName(name, taken) {
  const used = new Set(taken.map(key));
  if (!used.has(key(name))) return name;
  for (let n = 2; ; n++) {
    const tail = ` ${n}`;
    const next = `${name.slice(0, 180 - tail.length).trimEnd()}${tail}`;
    if (!used.has(key(next))) return next;
  }
}
