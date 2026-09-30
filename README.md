# Cloudways Status Monitor

Persistent Node.js/Express diagnostic monitor for Cloudways Velocity.

## What it does

- Runs continuously as an Express application.
- Polls the public Cloudways Statuspage API every 30 seconds.
- Logs overall status, components, unresolved incidents, and scheduled maintenance.
- Provides `/`, `/health`, and `/status` endpoints.
- Does not send Discord notifications yet.

## Velocity configuration

- Framework Preset: Express
- Branch: main
- Node: v24
- Root Directory: ./
- Package Manager: Yarn
- Entry File: index.js

## Deployment

Velocity can install dependencies and start the app using the package.json scripts.

Build:
`yarn run build`

Start:
`yarn start`
