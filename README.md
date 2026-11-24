# Finance AFE Workbench

A capital-expenditure workbench that takes an Authorization for Expenditure (AFE) from request through routing, approval, e-signature and capitalisation as a fixed asset.

> **About this repository.** Built for a Fortune-500 life-sciences company and running in production there after security review and change-advisory-board (CAB) approval. This public copy is anonymised: the client's name and branding are replaced with the placeholder "Acme", and every person, customer, product, price, address and identifier in the seed data is synthetic. Internal hostnames, cloud resource names, credentials and deployment runbooks have been removed. Some test fixtures that were exports of real business files were not published, so a few tests are expected to fail (listed under **Tests**).

## Outcomes in production

- **100+ users** across requesters, approvers and fixed-asset accounting
- **$25M+ in capital requests processed in Q3 2026**
- Live in production after security review and CAB approval

## The problem

Capex requests travelled as spreadsheets and email chains. Requesters didn't know who had to approve, approvers signed the wrong version, and the fixed-asset team rebuilt each project by hand: assets under construction (AuC), capitalisation and reconciliation against the ERP budget baseline. Audit questions took days to answer.

## What it does

- **Requester-first wizard.** Guides the requester through project, cost centre, budget pot, quotes and justification, and validates as they go.
- **Approval routing from the approver matrix.** Derives the full approval chain from a matrix of more than 2,500 rows (division, cost centre, amount thresholds, delegations) and explains why each approver is on it.
- **E-signature.** Generates the AFE PDF and runs it through a DocuSign envelope. A built-in simulator is used for local development.
- **Quote reading (optional AI).** Azure AI Document Intelligence reads attached vendor quotes and checks them against the request. This is off by default and switched on by an admin feature flag.
- **Fixed-asset tracker.** Tracks internal orders, AuC and fixed-asset numbers, capitalisation status and comments for each project, reconciled against the ERP budget baseline.
- **Financials and reporting.** Budget versus committed versus actual per project and division. Master data (approver matrix, budgets, recon file) is imported from Excel.

## Architecture

```
Vanilla JS SPA (public/)  ──►  Express (server.js)  ──►  rules engine (lib/)  ──►  PostgreSQL or JSON store
                                     │
                                     ├─► PDF generation (pdf-lib)  ──►  DocuSign (live or simulated)
                                     └─► Document Intelligence (optional quote reading)
```

## Stack

Node.js, Express, PostgreSQL (`pg`), pdf-lib, DocuSign eSignature REST API, Azure AI Document Intelligence, vanilla JavaScript front end, Azure App Service with Entra ID Easy Auth.

## Running locally (synthetic data)

```bash
npm install
npm start            # serves on http://localhost:8080 and seeds itself from /seed
```

Without database settings the app uses an in-memory or JSON store, and DocuSign runs in simulated mode. `docker compose up -d` starts a local PostgreSQL if you want to try the Postgres store.

## Tests

The suite is a set of smoke scripts in `tools/` (rules, routing, envelope, wizard, financials, projects, masters and boot). Some of them need the local server running (`node tools/run-local.js`).

Result on this public copy: 779 checks passed, 1 failed (a fixture spreadsheet that was not published). The gzip check in the boot script also crashes on Node 24 on the original code.

## License

MIT. See [LICENSE](LICENSE). Design documents are in [`docs/`](docs/).
