import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const STATUS_URL = "https://status.cloudways.com/api/v2/summary.json";
const POLL_INTERVAL_MS = 30_000;

let latestStatus = {
  checkedAt: null,
  overall: null,
  indicator: null,
  components: [],
  incidents: [],
  maintenance: [],
  error: null
};

async function fetchCloudwaysStatus() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(STATUS_URL, {
      headers: {
        "User-Agent": "cloudways-status-discord/0.2.0"
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

async function checkCloudwaysStatus() {
  try {
    const data = await fetchCloudwaysStatus();

    latestStatus = {
      checkedAt: new Date().toISOString(),
      overall: data.status?.description ?? "Unknown",
      indicator: data.status?.indicator ?? "unknown",
      components: (data.components ?? []).map((component) => ({
        id: component.id,
        name: component.name,
        status: component.status
      })),
      incidents: (data.incidents ?? []).map((incident) => ({
        id: incident.id,
        name: incident.name,
        status: incident.status,
        impact: incident.impact,
        updatedAt: incident.updated_at,
        latestUpdate: incident.incident_updates?.[0]?.body ?? null
      })),
      maintenance: (data.scheduled_maintenances ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        impact: item.impact,
        scheduledFor: item.scheduled_for ?? null,
        updatedAt: item.updated_at ?? null
      })),
      error: null
    };

    console.log(
      `[${latestStatus.checkedAt}] Overall: ${latestStatus.overall} (${latestStatus.indicator})`
    );
    console.log(
      `Components: ${latestStatus.components.length} | Incidents: ${latestStatus.incidents.length} | Maintenance: ${latestStatus.maintenance.length}`
    );

    for (const component of latestStatus.components) {
      if (component.status !== "operational") {
        console.log(
          `COMPONENT ALERT: ${component.name} -> ${component.status}`
        );
      }
    }

    for (const incident of latestStatus.incidents) {
      console.log(
        `ACTIVE INCIDENT: ${incident.name} | ${incident.status} | ${incident.impact}`
      );
    }
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
    indicator: latestStatus.indicator
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

  await checkCloudwaysStatus();

  setInterval(checkCloudwaysStatus, POLL_INTERVAL_MS);
});
