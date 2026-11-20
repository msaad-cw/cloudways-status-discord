import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const STATUS_URL = "https://status.cloudways.com/api/v2/summary.json";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TEST_TOKEN = process.env.TEST_TOKEN || null;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "cloudways-status-discord/1.1.0";

// On startup, incidents/maintenance updated within this window are announced
// instead of silently absorbed into the baseline, so events that happen while
// the app is restarting or redeploying are not lost.
const STARTUP_LOOKBACK_MS =
  (Number(process.env.STARTUP_LOOKBACK_MINUTES) || 15) * 60_000;

// Discord embed limits (description max is 4096).
const MAX_DESCRIPTION = 4000;
const MAX_UPDATE_BODY = 1000;

if (!DISCORD_WEBHOOK_URL) {
  console.error("ERROR: DISCORD_WEBHOOK_URL environment variable is not configured.");
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception, exiting:", error);
  process.exit(1);
});

let previousState = null;
let checkInProgress = false;

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

let discordStatus = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  consecutiveFailures: 0
};

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function webhookUrl() {
  // Handles webhook URLs that already include a query string (e.g. ?thread_id=).
  const url = new URL(DISCORD_WEBHOOK_URL);
  url.searchParams.set("wait", "true");
  return url.toString();
}

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
        shortlink: incident.shortlink ?? null,
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

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCloudwaysStatus() {
  const response = await fetchWithTimeout(STATUS_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Cloudways API returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error(`Cloudways API returned non-JSON content (${contentType})`);
  }

  return await response.json();
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

  for (const component of current.components) {
    const old = previousComponents.get(component.id);

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
      changes.push({ type: "incident_created", incident });
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
      changes.push({ type: "incident_resolved", incident });
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
      changes.push({ type: "maintenance_created", maintenance: item });
      continue;
    }

    if (
      old.status !== item.status ||
      old.impact !== item.impact ||
      old.updatedAt !== item.updatedAt
    ) {
      changes.push({ type: "maintenance_updated", maintenance: item });
    }
  }

  for (const [id, item] of previousMaintenance) {
    if (!currentMaintenance.has(id)) {
      changes.push({ type: "maintenance_removed", maintenance: item });
    }
  }

  return changes;
}

// Used once at startup: turns recently updated items into alerts so a
// restart does not swallow an incident that started during downtime.
function recentItemsAsChanges(state) {
  const cutoff = Date.now() - STARTUP_LOOKBACK_MS;
  const isRecent = (iso) => Boolean(iso) && Date.parse(iso) >= cutoff;
  const changes = [];

  for (const incident of state.incidents) {
    if (isRecent(incident.updatedAt)) {
      changes.push({ type: "incident_updated", incident });
    }
  }

  for (const item of state.maintenance) {
    if (isRecent(item.updatedAt)) {
      changes.push({ type: "maintenance_updated", maintenance: item });
    }
  }

  return changes;
}

function severityForChanges(changes) {
  if (changes.some((c) =>
    (c.type === "incident_created" || c.type === "incident_updated") &&
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

  if (changes.some((c) => c.type.startsWith("maintenance_"))) {
    return "🛠️ Cloudways Maintenance Update";
  }

  return "ℹ️ Cloudways Status Update";
}

function statusLabel(status) {
  return String(status ?? "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function quote(text) {
  return truncate(text, MAX_UPDATE_BODY)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function buildDescription(changes) {
  const lines = [];

  for (const change of changes.slice(0, 10)) {
    switch (change.type) {
      case "overall":
        lines.push(
          `**Overall status:** ${statusLabel(change.previous)} → **${statusLabel(change.current)}**`
        );
        break;

      case "component":
        lines.push(
          `**${change.name}:** ${statusLabel(change.previous)} → **${statusLabel(change.current)}**`
        );
        break;

      case "incident_created":
      case "incident_updated": {
        const incident = change.incident;
        const link = incident.shortlink ? `\n${incident.shortlink}` : "";
        lines.push(
          `**${incident.name}**\nStatus: **${statusLabel(incident.status)}** · Impact: **${statusLabel(incident.impact)}**${link}`
        );
        if (incident.latestUpdate) {
          lines.push(quote(incident.latestUpdate));
        }
        break;
      }

      case "incident_resolved":
        lines.push(`**${change.incident.name}** has been resolved.`);
        break;

      case "maintenance_created":
      case "maintenance_updated": {
        const item = change.maintenance;
        lines.push(
          `**${item.name}**\nStatus: **${statusLabel(item.status)}** · Impact: **${statusLabel(item.impact)}**`
        );
        break;
      }

      case "maintenance_removed":
        lines.push(`**${change.maintenance.name}** is no longer listed as scheduled maintenance.`);
        break;
    }
  }

  if (changes.length > 10) {
    lines.push(`…and ${changes.length - 10} additional changes.`);
  }

  // Discord rejects embeds with an empty description.
  const description = lines.join("\n\n") ||
    "The Cloudways status page was updated. See the status page for details.";

  return truncate(description, MAX_DESCRIPTION);
}

async function postToDiscord(payload, attempt = 1) {
  const response = await fetchWithTimeout(webhookUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT
    },
    body: JSON.stringify(payload)
  });

  if (response.status === 429 && attempt < 3) {
    const body = await response.json().catch(() => ({}));
    const waitMs = Math.ceil((Number(body.retry_after) || 2) * 1000);
    console.warn(`Discord rate limited, retrying in ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return postToDiscord(payload, attempt + 1);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Discord webhook returned HTTP ${response.status}: ${truncate(body, 500)}`
    );
  }
}

function recordDiscordResult(error) {
  if (error) {
    discordStatus = {
      ...discordStatus,
      lastErrorAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
      consecutiveFailures: discordStatus.consecutiveFailures + 1
    };
  } else {
    discordStatus = {
      ...discordStatus,
      lastSuccessAt: new Date().toISOString(),
      consecutiveFailures: 0
    };
  }
}

async function sendDiscordAlert(changes, { catchUp = false } = {}) {
  const colors = {
    critical: 0xED4245,
    warning: 0xFEE75C,
    resolved: 0x57F287,
    info: 0x5865F2
  };

  const fields = [
    {
      name: "Detected",
      value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
      inline: true
    },
    {
      name: "Monitor",
      value: catchUp ? "Detected on monitor startup" : "Cloudways Status API",
      inline: true
    }
  ];

  const payload = {
    username: "Cloudways Status",
    embeds: [
      {
        title: titleForChanges(changes),
        description: buildDescription(changes),
        color: colors[severityForChanges(changes)],
        url: "https://status.cloudways.com/",
        fields,
        footer: { text: "Cloudways Status Monitor" }
      }
    ],
    allowed_mentions: { parse: [] }
  };

  await postToDiscord(payload);
}

async function notify(changes, options) {
  try {
    await sendDiscordAlert(changes, options);
    recordDiscordResult(null);
    console.log("Discord alert sent successfully.");
  } catch (error) {
    recordDiscordResult(error);
    console.error("Discord alert failed:", discordStatus.lastError);
    // State still advances so a Discord outage does not cause repeated
    // notifications for the same status on every poll. Failures are now
    // visible on /health instead of being silent.
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

    if (previousState === null) {
      previousState = currentState;

      console.log(
        `[${latestStatus.checkedAt}] Baseline initialized: ${currentState.overall} (${currentState.indicator})`
      );
      console.log(
        `Components: ${currentState.components.length} | Incidents: ${currentState.incidents.length} | Maintenance: ${currentState.maintenance.length}`
      );

      const recent = recentItemsAsChanges(currentState);
      if (recent.length > 0) {
        console.log(`${recent.length} recently updated item(s) found on startup, announcing.`);
        await notify(recent, { catchUp: true });
      }
      return;
    }

    const changes = detectChanges(previousState, currentState);

    if (changes.length === 0) {
      console.log(`[${latestStatus.checkedAt}] No changes. Overall: ${currentState.overall}`);
      return;
    }

    console.log(`[${latestStatus.checkedAt}] ${changes.length} status change(s) detected.`);
    for (const change of changes) {
      console.log(JSON.stringify(change));
    }

    await notify(changes);
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

// setTimeout chain instead of setInterval so a slow check (timeouts,
// rate-limit retries) never overlaps with the next one.
async function pollLoop() {
  if (!checkInProgress) {
    checkInProgress = true;
    try {
      await checkCloudwaysStatus();
    } finally {
      checkInProgress = false;
    }
  }
  setTimeout(pollLoop, POLL_INTERVAL_MS);
}

function isStale() {
  if (!latestStatus.checkedAt) return true;
  return Date.now() - Date.parse(latestStatus.checkedAt) > POLL_INTERVAL_MS * 4;
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
  const problems = [];
  if (latestStatus.error) problems.push(`status check: ${latestStatus.error}`);
  if (isStale()) problems.push("polling loop is stale");
  if (discordStatus.consecutiveFailures > 0) problems.push(`discord: ${discordStatus.lastError}`);

  res.status(problems.length ? 503 : 200).json({
    status: problems.length ? "degraded" : "ok",
    problems,
    lastCheck: latestStatus.checkedAt,
    discord: discordStatus,
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.get("/status", (_req, res) => {
  res.json({ ...latestStatus, discord: discordStatus });
});

app.get("/test-discord", async (req, res) => {
  if (TEST_TOKEN && req.query.token !== TEST_TOKEN) {
    return res.status(401).json({ success: false, error: "Invalid or missing token" });
  }

  try {
    await postToDiscord({
      username: "Cloudways Status",
      embeds: [
        {
          title: "🧪 Cloudways Status Monitor Test",
          description: "Discord webhook is working correctly. This is a temporary test notification.",
          color: 0x5865F2,
          fields: [
            { name: "Monitor", value: "Online", inline: true },
            { name: "Cloudways Status", value: latestStatus.overall ?? "Unknown", inline: true },
            { name: "Poll Interval", value: `${POLL_INTERVAL_MS / 1000} seconds`, inline: true }
          ],
          footer: { text: "Cloudways Status Monitor" },
          timestamp: new Date().toISOString()
        }
      ],
      allowed_mentions: { parse: [] }
    });

    recordDiscordResult(null);
    res.json({
      success: true,
      message: "Test Discord notification sent.",
      cloudwaysStatus: latestStatus.overall
    });
  } catch (error) {
    recordDiscordResult(error);
    console.error("Test Discord notification failed:", discordStatus.lastError);
    res.status(502).json({ success: false, error: discordStatus.lastError });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Cloudways Status Monitor started on port ${PORT}`);
  console.log(`Polling Cloudways every ${POLL_INTERVAL_MS / 1000} seconds`);
  console.log(`Startup lookback: ${STARTUP_LOOKBACK_MS / 60_000} minutes`);
  pollLoop();
});
