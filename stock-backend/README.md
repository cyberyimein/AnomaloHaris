# Stock Backend

This directory contains Anomalo's integrated market-analysis engine, migrated from KabuLens.
It is installed as the `stock_backend` Python package and runs in the same FastAPI process as
the agent backend; a separate KabuLens service or report-publishing process is no longer needed.

## Runtime flow

1. `POST /api/stocks/scan` starts a scan in a worker thread.
2. `stock_backend.workflows.morning_scan` reads `config/settings.yaml` and `watchlists.yaml`.
3. The workflow writes JSON and Markdown artifacts under `stock-backend/outputs/`.
4. The report is published directly to Anomalo's in-memory report store.
5. `GET /api/stocks/reports/latest` feeds the Stock Analysis view and restores the last report
   from disk after a server restart.

The default mode is OpenD at `127.0.0.1:11111`. Override it from the root `.env` with
`ANOMALO_STOCK_DATA_MODE`, `ANOMALO_STOCK_OPEND_HOST`, and `ANOMALO_STOCK_OPEND_PORT`.
Use `ANOMALO_STOCK_DATA_MODE=mock` for an offline deterministic scan.

When `ANOMALO_ENV=production`, Anomalo starts an in-process scheduler and runs this workflow daily
at 22:00 in `Asia/Tokyo`. The web UI's **Run Scan** button always remains available. Automatic and
manual runs share a lock, so they cannot execute concurrently.
Deployment mounts `outputs/` and `data/` beneath Anomalo's remote persistent-data directory, so
the latest report, scan history, and Futu runtime cache survive container replacement.

The original command-line entry point remains available inside the unified environment:

```bash
PYTHONPATH=stock-backend .venv/bin/python -m stock_backend.workflows.morning_scan
```
