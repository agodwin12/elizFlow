/**
 * Add whole calendar months to a date (e.g. Jan 31 + 1 month → Feb 28/29).
 * Clamps the day to the last day of the target month when needed.
 */
export function addMonths(date: Date, months: number): Date {
    const d = new Date(date.getTime());
    const day = d.getDate();
    d.setDate(1); // avoid overflow while changing month
    d.setMonth(d.getMonth() + months);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return d;
}

/** Add whole days to a date. */
export function addDays(date: Date, days: number): Date {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + days);
    return d;
}
