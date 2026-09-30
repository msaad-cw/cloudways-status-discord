import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const STATUS_URL = "https://status.cloudways.com/api/v2/summary.json";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const POLL_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

if (!DISCORD_WEBHOOK_URL) {
  console.error("ERROR: DISCORD_WEBHOOK_URL environment variable is not configured.");
  process.exit(1);
}

let previousState = null;
let latestStatus = {
  checkedAt: null,
  overall: null,
  indicator: null,
  components: [],
  incidents: [],
  maintenance: [],
  error: null,
  initialized: false
};

function normalizeStatus(data) {
  return {
    overall: data.status?.description ?? "Unknown",
    indicator: data.status?.indicator ?? "unknown",

    components: (data.components ?? [])
      .map((component) => ({
        id: component.id,
        name: component.name,
        status: component.status
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),

    incidents: (data.incidents ?? [])
      .map((incident) => ({
        id: incident.id,
        name: incident.name,
        status: incident.status,
        impact: incident.impact,
        updatedAt: incident.updated_at,
        latestUpdateId: incident.incident_updates?.[0]?.id ?? null,
        latestUpdate: incident.incident_updates?.[0]?.body ?? null
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),

    maintenance: (data.scheduled_maintenances ?? [])
      .map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        impact: item.impact,
        scheduledFor: item.scheduled_for ?? null,
        updatedAt: item.updated_at ?? null
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  };
}

async function fetchCloudwaysStatus() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(STATUS_URL, {
      headers: {
        "User-Agent": "cloudways-status-discord/1.0.0"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Cloudways API returned HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function detectChanges(previous, current) {
  const changes = [];

  if (previous.overall !== current.overall ||
      previous.indicator !== current.indicator) {
    changes.push({
      type: "overall",
      previous: previous.overall,
      current: current.overall,
      indicator: current.indicator
    });
  }

  const previousComponents = new Map(
    previous.components.map((component) => [component.id, component])
  );

  const currentComponents = new Map(
    current.components.map((component) => [component.id, component])
  );

  for (const [id, component] of currentComponents) {
    const old = previousComponents.get(id);

    if (old && old.status !== component.status) {
      changes.push({
        type: "component",
        name: component.name,
        previous: old.status,
        current: component.status
      });
    }
  }

  const previousIncidents = new Map(
    previous.incidents.map((incident) => [incident.id, incident])
  );

  const currentIncidents = new Map(
    current.incidents.map((incident) => [incident.id, incident])
  );

  for (const [id, incident] of currentIncidents) {
    const old = previousIncidents.get(id);

    if (!old) {
      changes.push({
        type: "incident_created",
        incident
      });
      continue;
    }

    if (
      old.status !== incident.status ||
      old.impact !== incident.impact ||
      old.latestUpdateId !== incident.latestUpdateId
    ) {
      changes.push({
        type: "incident_updated",
        incident,
        previousStatus: old.status
      });
    }
  }

  for (const [id, incident] of previousIncidents) {
    if (!currentIncidents.has(id)) {
      changes.push({
        type: "incident_resolved",
        incident
      });
    }
  }

  const previousMaintenance = new Map(
    previous.maintenance.map((item) => [item.id, item])
  );

  const currentMaintenance = new Map(
    current.maintenance.map((item) => [item.id, item])
  );

  for (const [id, item] of currentMaintenance) {
    const old = previousMaintenance.get(id);

    if (!old) {
      changes.push({
        type: "maintenance_created",
        maintenance: item
      });
      continue;
    }

    if (
      old.status !== item.status ||
      old.impact !== item.impact ||
      old.updatedAt !== item.updatedAt
    ) {
      changes.push({
        type: "maintenance_updated",
        maintenance: item
      });
    }
  }

  for (const [id, item] of previousMaintenance) {
    if (!currentMaintenance.has(id)) {
      changes.push({
        type: "maintenance_removed",
        maintenance: item
      });
    }
  }

  return changes;
}

function severityForChanges(changes) {
  if (changes.some((c) =>
    c.type === "incident_created" &&
    ["critical", "major"].includes(c.incident.impact)
  )) {
    return "critical";
  }

  if (changes.some((c) =>
    c.type === "incident_created" ||
    c.type === "incident_updated" ||
    c.type === "component"
  )) {
    return "warning";
  }

  if (changes.some((c) => c.type === "incident_resolved")) {
    return "resolved";
  }

  return "info";
}

function titleForChanges(changes) {
  if (changes.some((c) => c.type === "incident_created")) {
    return "🔴 Cloudways Service Incident";
  }

  if (changes.some((c) => c.type === "incident_updated")) {
    return "🟠 Cloudways Incident Update";
  }

  if (changes.some((c) => c.type === "incident_resolved")) {
    return "🟢 Cloudways Incident Resolved";
  }

  if (changes.some((c) => c.type === "component")) {
    return "⚠️ Cloudways Component Status Change";
  }

  if (changes.some((c) =>
    c.type === "maintenance_created" ||
    c.type === "maintenance_updated"
  )) {
    return "🛠️ Cloudways Maintenance Update";
  }

  return "ℹ️ Cloudways Status Update";
}

function statusLabel(status) {
  return String(status ?? "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildDescription(changes) {
  const lines = [];

  for (const change of changes.slice(0, 10)) {
    if (change.type === "overall") {
      lines.push(
        `**Overall status:** ${statusLabel(change.previous)} → **${statusLabel(change.current)}**`
      );
    }

    if (change.type === "component") {
      lines.push(
        `**${change.name}** — ${statusLabel(change.previous)} → **${statusLabel(change.current)}**`
      );
    }

    if (change.type === "incident_created") {
      const incident = change.incident;
      lines.push(
        `**${incident.name}**\nStatus: **${statusLabel(incident.status)}** · Impact: **${statusLabel(incident.impact)}**`
      );

      if (incident.latestUpdate) {
        lines.push(`> ${incident.latestUpdate}`);
      }
    }

    if (change.type === "incident_updated") {
      const incident = change.incident;
      lines.push(
        `**${incident.name}**\nStatus: **${statusLabel(incident.status)}** · Impact: **${statusLabel(incident.impact)}**`
      );

      if (incident.latestUpdate) {
        lines.push(`> ${incident.latestUpdate}`);
      }
    }

    if (change.type === "incident_resolved") {
      lines.push(`**${change.incident.name}** has been resolved.`);
    }

    if (change.type === "maintenance_created" ||
        change.type === "maintenance_updated") {
      const item = change.maintenance;
      lines.push(
        `**${item.name}**\nStatus: **${statusLabel(item.status)}** · Impact: **${statusLabel(item.impact)}**`
      );
    }
  }

  if (changes.length > 10) {
    lines.push(`\n…and ${changes.length - 10} additional changes.`);
  }

  return lines.join("\n\n");
}

async function sendDiscordAlert(changes) {
  const severity = severityForChanges(changes);

  const colors = {
    critical: 0xED4245,
    warning: 0xFEE75C,
    resolved: 0x57F287,
    info: 0x5865F2
  };

  const payload = {
    username: "Cloudways Status",
    embeds: [
      {
        title: titleForChanges(changes),
        description: buildDescription(changes),
        color: colors[severity],
        url: "https://status.cloudways.com/",
        fields: [
          {
            name: "Detected",
            value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
            inline: true
          },
          {
            name: "Monitor",
            value: "Cloudways Status API",
            inline: true
          }
        ],
        footer: {
          text: "Cloudways Status Monitor"
        }
      }
    ],
    allowed_mentions: {
      parse: []
    }
  };

  const response = await fetch(`${DISCORD_WEBHOOK_URL}?wait=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "cloudways-status-discord/1.0.0"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Discord webhook returned HTTP ${response.status}: ${body}`
    );
  }
}

async function checkCloudwaysStatus() {
  try {
    const data = await fetchCloudwaysStatus();
    const currentState = normalizeStatus(data);

    latestStatus = {
      checkedAt: new Date().toISOString(),
      ...currentState,
      error: null,
      initialized: true
    };

    // First successful check establishes the baseline.
    // This prevents existing incidents from immediately spamming Discord.
    if (previousState === null) {
      previousState = currentState;

      console.log(
        `[${latestStatus.checkedAt}] Baseline initialized: ${currentState.overall} (${currentState.indicator})`
      );
      console.log(
        `Components: ${currentState.components.length} | Incidents: ${currentState.incidents.length} | Maintenance: ${currentState.maintenance.length}`
      );
      return;
    }

    const changes = detectChanges(previousState, currentState);

    if (changes.length === 0) {
      console.log(
        `[${latestStatus.checkedAt}] No changes. Overall: ${currentState.overall}`
      );
      return;
    }

    console.log(
      `[${latestStatus.checkedAt}] ${changes.length} status change(s) detected.`
    );

    for (const change of changes) {
      console.log(JSON.stringify(change));
    }

    try {
      await sendDiscordAlert(changes);
      console.log("Discord alert sent successfully.");
    } catch (discordError) {
      console.error(
        "Discord alert failed:",
        discordError instanceof Error
          ? discordError.message
          : String(discordError)
      );
      // Keep the state updated so a Discord outage does not cause
      // repeated notifications for the same status on every poll.
    }

    previousState = currentState;
  } catch (error) {
    latestStatus = {
      ...latestStatus,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };

    console.error(
      `[${latestStatus.checkedAt}] Cloudways status check failed:`,
      latestStatus.error
    );
  }
}

app.get("/", (_req, res) => {
  res.json({
    service: "Cloudways Status Monitor",
    status: "running",
    lastCheck: latestStatus.checkedAt,
    overall: latestStatus.overall,
    indicator: latestStatus.indicator,
    initialized: latestStatus.initialized
  });
});

app.get("/health", (_req, res) => {
  res.status(latestStatus.error ? 503 : 200).json({
    status: latestStatus.error ? "degraded" : "ok",
    lastCheck: latestStatus.checkedAt,
    error: latestStatus.error
  });
});

app.get("/status", (_req, res) => {
  res.json(latestStatus);
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Cloudways Status Monitor started on port ${PORT}`);
  console.log(`Polling Cloudways every ${POLL_INTERVAL_MS / 1000} seconds`);
  console.log("Discord notifications: enabled");

  await checkCloudwaysStatus();

  setInterval(checkCloudwaysStatus, POLL_INTERVAL_MS);
});
