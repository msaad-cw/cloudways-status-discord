# Cloudways Status Discord

Diagnostic Node.js application for the public Cloudways Statuspage API.

## Current version

This first version only checks:

`https://status.cloudways.com/api/v2/summary.json`

It prints:

- Overall status
- Components and their statuses
- Unresolved incidents
- Scheduled maintenance

No Discord webhook is included yet.

## Run locally

```bash
npm start
```

## Velocity

Use:

- Node.js: 18+
- Build command: `npm install`
- Start command: `npm start`

No environment variables are required for this diagnostic version.
