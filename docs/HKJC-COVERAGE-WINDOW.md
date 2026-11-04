# HKJC public matchList coverage window (measured)

Measured on 2026-11-04 ~16:40 HKT against `https://info.cld.hkjc.com/graphql/base-get/`
using the exact frontend operation in `collector/sources/hkjc-query.graphql`
(`fbOddsTypes: ['HDC']`, `showAllMatch: true`).

## What we observed

| Fact | Value |
| --- | --- |
| HTTP status | 200, `content-type: application/json; charset=utf-8` |
| Payload size | 113,641 bytes |
| `data.matches` length | 40 |
| Earliest kick-off in snapshot | 2026-11-04T15:45+08:00 (in play) |
| Latest kick-off in snapshot | 2026-11-06T11:05+08:00 |
| Effective forward window | roughly `now + 42h` |

Tournament codes present in that snapshot:

`AC2 5, RFC 2, ACL 2, CUP 1, UEC 7, UCL 9, ED1 1, CHC 2, BD1 5, MD1 3, AD2 1, UDC 1, APL 1`

None of the five tracked leagues (`EPL`, `SFL`, `ISA`, `GSL`, `FFL`) appear, and no
European fixture from the evening of 2026-11-06 is listed either.

## Why fixtures report `fixture_outside_public_window`

The report fixtures are 2026-11-06T19:30Z .. 2026-11-08T20:00Z (48 fixtures across
`BL1 9, SA 10, FL1 9, PL 10, PD 10`), i.e. 2026-11-07T03:30 HKT ..
2026-11-09T04:00 HKT. Every one of them sits beyond the measured window edge, so the
snapshot cannot answer for them yet.

This is a **coverage limit, not an identity-matching bug**. `parseHkjc` now reports
`fixture_outside_public_window` (with the snapshot's `windowEnd`) instead of
`fixture_identity_unmatched`, and the source diagnostic carries
`coverageWindowStart` / `coverageWindowEnd`.

## Bounds that were tried and rejected

Passing `startDate` / `endDate` / `startIndex` / `endIndex` to the same operation all
return `{"errors":[{"message":"Invalid queration arguments. Try double-checking it!"}]}`
for these formats:

- `2026-11-05` / `2026-11-09`
- `2026-11-05+08:00` / `2026-11-09+08:00`
- `2026-11-05T00:00:00.000+08:00` / `2026-11-09T00:00:00.000+08:00`
- `11/05/2026`
- `startIndex: 0, endIndex: 200`

The public endpoint only accepts the argument set the frontend actually sends. There
is no `tournaments` query either (`Your query doesn't match the schema`), so a
league-id based backfill is not available.

## Consequence for the second independent Asian source

HKJC can serve as the second independent Asian quote group, but only for fixtures
within roughly two days of kick-off. Collection therefore has to run close to the
match, and a fixture that has no HKJC quote must be classified as
`fixture_outside_public_window` rather than treated as a failed identity match.
