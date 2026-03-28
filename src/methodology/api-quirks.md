# YNAB API Quirks and Limitations

Documented behaviors of the YNAB public API (`api.ynab.com/v1`) that differ from what the SDK types suggest or that require workarounds.

## Scheduled Transaction Frequencies

### Only 5 frequency values are accepted by the API

The YNAB JavaScript SDK (`ynab` npm package) defines 13 frequency values in its `ScheduledTransactionFrequency` enum:

```
never, daily, weekly, everyOtherWeek, twiceAMonth, every4Weeks,
monthly, everyOtherMonth, every3Months, every4Months, twiceAYear,
yearly, everyOtherYear
```

**The API only accepts 5 of these on both create and update:**

| Value | Create | Update |
|-------|--------|--------|
| `never` | Accepted | Accepted |
| `daily` | Accepted | Accepted |
| `weekly` | Accepted | Accepted |
| `monthly` | Accepted | Accepted |
| `yearly` | Accepted | Accepted |
| All others | **Rejected** | **Rejected** |

Rejected values produce errors like: `"frequency Every Other Month is not a valid frequency"`. The API converts the camelCase enum value to display text (splitting on uppercase characters) before validation.

**Verified:** 2026-03-27 via exhaustive curl tests against `POST /v1/plans/{id}/scheduled_transactions` for all 13 enum values. Each compound value was individually tested and rejected. Single-word values were individually tested and accepted. Successful test creates were immediately deleted.

### Compound frequencies exist in read responses

Scheduled transactions created through the YNAB web or mobile app can have compound frequencies (`every4Months`, `twiceAMonth`, etc.). These values appear normally in API read responses (`GET /scheduled_transactions`). The limitation only applies to write operations.

**Verified:** 2026-03-27 by reading an existing `every4Months` scheduled transaction via `GET /v1/plans/{id}/scheduled_transactions`. The response included `"frequency": "every4Months"`.

### Compound-frequency transactions are effectively read-only

Scheduled transactions with compound frequencies (created through the YNAB app) **cannot be modified through the API at all**. Any PUT request fails — even when the `frequency` field is completely absent from the request body. The API validates the existing frequency from the database as part of PUT processing and rejects it.

```
PUT /v1/budgets/{id}/scheduled_transactions/{id}
Body: {"scheduled_transaction": {"account_id": "...", "date": "2026-04-17", "amount": -19990, "memo": "test"}}
Response: {"error": {"id": "400", "name": "bad_request", "detail": "frequency Every4 Months is not a valid frequency"}}
```

This means you cannot change the memo, amount, payee, category, date, or any other field on these transactions through the API.

**Verified:** 2026-03-27 via raw curl PUT to `/v1/budgets/{id}/scheduled_transactions/{id}` with the `frequency` field completely absent from the JSON body. The API still returned the compound frequency validation error.

### Forcing an update is destructive and irreversible

The only way to make a PUT succeed on a compound-frequency transaction is to include a supported frequency value (e.g., `"monthly"`) in the request body. This overwrites the original compound frequency. Since the API also rejects compound frequencies on create, the original frequency **cannot be restored through the API** — it can only be set back through the YNAB app.

**Verified:** 2026-03-27 via raw curl PUT with `"frequency": "monthly"` in the body on a transaction that had `every4Months`. The PUT succeeded and the frequency was permanently changed to `monthly`. A subsequent POST attempting to create a replacement with `"frequency": "every4Months"` was rejected.

### Summary

| Operation | Compound frequency | Simple frequency |
|-----------|-------------------|-----------------|
| Create | Rejected | Works |
| Read | Works | Works |
| Update (any field) | **Rejected** | Works |
| Update with forced simple frequency | Changes frequency irreversibly | Works |
| Delete | Works | Works |

### Workarounds

1. **Reading:** No workaround needed. Compound frequencies appear normally in GET responses.
2. **Creating:** Only the 5 supported values can be used. Compound frequencies can only be created through the YNAB app.
3. **Updating:** Compound-frequency transactions must be edited directly in the YNAB app. The MCP server omits the `frequency` field from the API payload when the user doesn't request a frequency change, but the API still rejects the request due to server-side validation of the existing frequency.
4. **Deleting:** Works normally regardless of frequency.

## Date Validation on Scheduled Transaction Updates

The `PUT` endpoint for scheduled transactions requires the `date` field to be no more than 1 week in the past and no more than 5 years in the future. When updating a scheduled transaction, the MCP server falls back to `existing.date_first` if no new date is provided. For old scheduled transactions where `date_first` is far in the past, this can cause validation failures.

The `date_next` field (the upcoming occurrence) is more appropriate as a fallback but is not part of the `SaveScheduledTransaction` input type — the API uses `date` to mean the start date of the recurrence pattern.
