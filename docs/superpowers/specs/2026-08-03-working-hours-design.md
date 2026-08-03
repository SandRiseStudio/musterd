# Working-hours sign and inherited schedules

**Date:** 2026-08-03
**Surface:** protocol, server roster projection, durable roster files, and `packages/web` office scene
**Status:** approved for implementation

## Goal

Give the office a delightful sign that communicates the Team's working hours while introducing a
reusable, optional working-hours concept. Team schedules provide defaults; Member schedules override
them. The sign must always render from data supplied by the Team projection.

## Data model

`WorkingHours` is an optional recurring weekly window:

```ts
type WorkingDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

type WorkingHours = {
  timezone: string; // IANA timezone identifier
  days: WorkingDay[]; // unique, non-empty
  start: string; // HH:mm
  end: string; // HH:mm, later than start for v1
};
```

The shared protocol schema validates the shape and normalizes no user input. Team and Member values
are optional. A Member's non-null value is the complete effective value; it does not merge with the
Team value. The server stores schedules but does not enforce them or synthesize Presence changes.

`revive` is seeded with:

```json
{
  "timezone": "America/Los_Angeles",
  "days": ["mon", "tue", "wed", "thu", "fri"],
  "start": "11:00",
  "end": "15:00"
}
```

## Data flow

1. The protocol package owns `WorkingHoursSchema`, its type, and boundary validation.
2. SQLite adds nullable Team and Member storage columns through a forward migration.
3. Durable `team.toml` and seat files may declare the corresponding optional values; reconcile preserves
   them as the file-backed source of truth.
4. `GET /teams/:slug` returns the Team's optional schedule and each Member's effective schedule. The
   Team schedule remains available separately so clients can explain inheritance.
5. The web live route carries the Team schedule into `OfficeScene` as data. No component creates the
   `11am-3pm` string or assumes the Team slug.

## Office sign

The sign is a small architectural object mounted on the office wall, near the existing wall dressing.
It reads as a warm enamel-and-paper placard: rounded pale-oak frame, mustard sunburst marker, small
weekday dots, and a softly glowing centre line. The visual language is magical and quirky through
texture, tiny stars, hand-placed dots, and a restrained breathing glow, while the actual copy stays
plain and legible:

`TEAM WORKING HOURS`
`MON–FRI · 11:00 AM–3:00 PM`
`PACIFIC TIME`

The renderer formats days, times, and timezone from `WorkingHours`. It uses the existing canvas font
tokens and palette. The sign scales with the office fit and remains readable at `/live`, `/broadcast`,
and `/office-preview`. Reduced-motion mode draws the final state without the glow pulse.

If the Team has no schedule, the sign is not painted and no placeholder copy appears. Member overrides
do not change the Team sign; they remain available to roster consumers as each Member's effective
working-hours value.

## Error handling

Malformed persisted JSON degrades to absent working hours, following the existing defensive roster
projection pattern. Invalid wire input is rejected by the protocol schema at the boundary. A missing
or unsupported timezone never becomes a guessed local timezone; it is rejected when written.

## Testing

- Protocol tests validate valid schedules, duplicate/empty days, invalid weekday/time/timezone values,
  and round-trip parsing.
- Server tests validate Team storage, Member storage, and Member-over-Team precedence.
- Durable roster tests validate TOML round trips and reconcile preservation.
- Web tests validate effective schedule formatting and the no-schedule omission rule.
- Office scene tests validate sign layout within the fit and that the schedule text is data-derived.
- Run the web unit suite, package build, and the required repository gates before claiming completion.

## Scope exclusions

- No schedule enforcement or automatic off-hours Presence transitions.
- No multiple windows per day, overnight windows, holiday exceptions, or per-day time ranges in v1.
- No editing/settings UI in this pass; the data model and read projection are the foundation for one.
