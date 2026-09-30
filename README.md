# Cloudways Status → Discord Monitor

A persistent Node.js/Express monitor for the public Cloudways Statuspage API.

## Features

- Polls Cloudways `summary.json` every 30 seconds.
- Detects overall status changes.
- Detects component status changes.
- Detects new incidents.
- Detects incident updates.
- Detects incident resolution.
- Detects scheduled maintenance changes.
- Sends Discord webhook embeds only when something changes.
- Establishes a baseline on startup so existing incidents do not trigger an alert immediately.
- Keeps running as a persistent Express application on Cloudways Velocity.

## Environment variable

Configure this in Velocity, NOT in GitHub:

`DISCORD_WEBHOOK_URL=<your Discord webhook URL>`

## Velocity configuration

- Framework Preset: Express
- Branch: main
- Node: v24
- Root Directory: ./
- Package Manager: Yarn
- Entry File: index.js

## Scripts

Build:
`yarn run build`

Start:
`yarn start`
