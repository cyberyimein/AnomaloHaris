import type { BotSchedule } from '@anomaloharis/contracts';
import { resolveLocalDateTime } from './tools.js';
export function parseInstant(value: string): Date {
    if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))
        throw new Error('Time must be an ISO timestamp with an explicit offset.');
    return new Date(value);
}
export function validateSchedule(schedule: BotSchedule): void {
    if (schedule.type === 'calendar')
        new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format();
    else {
        parseInstant(schedule.type === 'once' ? schedule.at : schedule.anchorAt);
        if (schedule.type === 'once' && schedule.expiresAt && +parseInstant(schedule.expiresAt) < +parseInstant(schedule.at))
            throw new Error('Expiry must follow the scheduled time.');
    }
}
/** Returns the first occurrence strictly after the supplied instant. */
export function nextScheduledTime(schedule: BotSchedule, after: string): string | null {
    validateSchedule(schedule);
    const start = parseInstant(after);
    if (schedule.type === 'once')
        return +parseInstant(schedule.at) > +start ? parseInstant(schedule.at).toISOString() : null;
    if (schedule.type === 'interval') {
        const anchor = +parseInstant(schedule.anchorAt);
        const interval = schedule.everySeconds * 1000;
        return new Date(anchor + Math.max(0, Math.floor((+start - anchor) / interval) + 1) * interval).toISOString();
    }
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(start).map(x => [x.type, x.value]));
    const wallDay = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
    for (let day = 0; day < 15; day++) {
        const candidate = new Date(+wallDay + day * 86400000);
        if (schedule.weekdays && !schedule.weekdays.includes(candidate.getUTCDay() || 7))
            continue;
        try {
            const instant = resolveLocalDateTime(`${candidate.toISOString().slice(0, 10)}T${schedule.localTime}:00`, schedule.timezone, 0);
            if (+instant > +start)
                return instant.toISOString();
        }
        catch { /* Nonexistent DST wall time: skip this date. */ }
    }
    throw new Error('Cannot resolve the next calendar occurrence.');
}
export function initialDue(schedule: BotSchedule, now: string): string {
    validateSchedule(schedule);
    if (schedule.type === 'once')
        return parseInstant(schedule.at).toISOString();
    return nextScheduledTime(schedule, new Date(Date.parse(now) - 1).toISOString())!;
}
