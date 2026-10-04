# Research order/note parsing safeguards

The research normalizer must preserve the raw `hchanh_order_history.csv` file and only deduplicate copied text when parser code asks for order cells through `getCell()`.

Rules derived from real EMR samples:

- If `Tên y lệnh` is identical to `Diễn biến`, it is not an independent order source.
- If `Y lệnh khác` is identical to `Tên y lệnh` or `Diễn biến`, parse it only once.
- Placeholder text such as `Y lệnh thuốc đã có` / `Thực hiện y lệnh thuốc đã có` must not create a medication record.
- `no_service` is metadata, not proof that an order is absent.
- Medication text should be parsed into drug name, strength, route, frequency and schedule when explicit.
- `Ngưng ...` is a stop event; `Duy trì ...` without a named drug is a reference/continuation statement, not a new named medication.
- Clinical-note extraction must obey `absence of mention != negative finding` and preserve `source_text` for every derived event.

`server/research/order_note_parser.js` contains the stricter parser primitives and clinical-event rules. The current normalization path immediately benefits from order-field dedupe through `table_io.getCell()` and stricter `normalizeDrugName()`. Future structured event tables should reuse these parser primitives rather than introducing a second rule set.
