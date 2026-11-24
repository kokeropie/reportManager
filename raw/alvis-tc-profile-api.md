# Alvis API: TC Profile (Service Performance)

Source docs: https://smile.alvis.id/docs/dashboard-api

Base URL: `https://smile.alvis.id/api/external/v1`

## Authentication

Send the shared API key in the `X-API-Key` header on every request.
A missing or wrong key returns `401`.

Keep the key out of the repo. Store it in an environment variable or a secrets file:

```bash
export ALVIS_API_KEY="<your key>"
```

## Endpoints

| Format | Method | Path |
|--------|--------|------|
| JSON   | GET    | `/service-performance/tc-profile` |
| Excel (.xlsx) | GET | `/service-performance/tc-profile/export` |

Note: the docs page lists the JSON endpoint as `/service-performance/tc-profilepaginated`,
which may be a typo. Try `/tc-profile` first. The `/tc-profile/export` path was verified
and returns a valid .xlsx file.

## What it returns

One row per travel consultant (TC) per generated month, with:

- Service Standard, Customer Satisfaction, Service Performance
- Survey counts
- Compliment, complaint, improvement and general feedback counts
  (derived from AI classification of survey comments)

The endpoint is read-only. It never generates a month. A month that has not
been generated has no rows and shows `not-generated` in `monthStatus`.

## Parameters

| Name | Required | Description |
|------|----------|-------------|
| `year` | Yes | 2020 to 2100 |
| `month` | No | 1 to 12, single month. A future month returns `400` |
| `fromMonth` / `toMonth` | No | Month range (defaults 1 and 12). Use instead of `month` |
| `branch` | No | List. Repeat the key for multiple values |
| `tc` | No | List. Repeat the key for multiple values |
| `limit` | No | JSON only. Up to 1000 rows per page (default 500) |
| `offset` | No | JSON only. Row offset for paging |

The export accepts the same parameters except `limit` and `offset`.
The file always includes every row.

## JSON response

```json
{
  "data": [ ... ],
  "pagination": { "total": 0, "limit": 500, "offset": 0 },
  "meta": { "cached": false, "generatedAt": "..." }
}
```

Page through results with `offset` until you have `pagination.total` rows.

## Excel export

Returns an `.xlsx` file. It includes a `Months` sheet showing which months are generated.
The `X-API-Key` header is required, so a plain browser link will not work. Use a script,
Postman or Power Query.

## Examples

```bash
# JSON, year 2026
curl -H "X-API-Key: $ALVIS_API_KEY" \
  "https://smile.alvis.id/api/external/v1/service-performance/tc-profile?year=2026&limit=1000"

# JSON, range with filters
curl -H "X-API-Key: $ALVIS_API_KEY" \
  "https://smile.alvis.id/api/external/v1/service-performance/tc-profile?year=2026&fromMonth=1&toMonth=6&branch=JKT&branch=SUB"

# Excel export, year 2026
curl -H "X-API-Key: $ALVIS_API_KEY" -o tc-profile-2026.xlsx \
  "https://smile.alvis.id/api/external/v1/service-performance/tc-profile/export?year=2026"
```

## Errors

| Status | Meaning |
|--------|---------|
| 400 | Invalid parameter. The body has an `errors` array listing each problem |
| 401 | Missing or invalid API key |
| 500 | Unexpected server error |
