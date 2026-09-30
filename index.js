const STATUS_URL = "https://status.cloudways.com/api/v2/summary.json";

async function fetchCloudwaysStatus() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(STATUS_URL, {
      headers: {
        "User-Agent": "cloudways-status-discord/0.1.0"
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

function printStatus(data) {
  console.log("\n=== Cloudways Status Diagnostic ===");
  console.log(`Checked: ${new Date().toISOString()}`);
  console.log(`Page: ${data.page?.name ?? "Unknown"}`);
  console.log(`URL: ${data.page?.url ?? "Unknown"}`);
  console.log(
    `Overall: ${data.status?.description ?? "Unknown"} (${data.status?.indicator ?? "unknown"})`
  );

  console.log("\nComponents:");
  if (!data.components?.length) {
    console.log("  None returned.");
  } else {
    for (const component of data.components) {
      console.log(`  - ${component.name}: ${component.status}`);
    }
  }

  console.log("\nUnresolved incidents:");
  if (!data.incidents?.length) {
    console.log("  None.");
  } else {
    for (const incident of data.incidents) {
      const latestUpdate = incident.incident_updates?.[0];
      console.log(`  - ${incident.name}`);
      console.log(`    ID: ${incident.id}`);
      console.log(`    Status: ${incident.status}`);
      console.log(`    Impact: ${incident.impact}`);
      console.log(`    Updated: ${incident.updated_at}`);
      if (latestUpdate?.body) {
        console.log(`    Latest update: ${latestUpdate.body}`);
      }
    }
  }

  console.log("\nScheduled maintenance:");
  if (!data.scheduled_maintenances?.length) {
    console.log("  None.");
  } else {
    for (const maintenance of data.scheduled_maintenances) {
      console.log(`  - ${maintenance.name}`);
      console.log(`    ID: ${maintenance.id}`);
      console.log(`    Status: ${maintenance.status}`);
      console.log(`    Impact: ${maintenance.impact}`);
      console.log(`    Scheduled: ${maintenance.scheduled_for ?? "n/a"}`);
    }
  }

  console.log("\nRaw response saved/available in memory only for this diagnostic run.");
}

try {
  const data = await fetchCloudwaysStatus();
  printStatus(data);
} catch (error) {
  console.error("\nCloudways status check failed:");
  console.error(error);
  process.exitCode = 1;
}
