/**
 * Cloudflare Worker that uses Pingdom API to test another worker from 30 global locations
 *
 * This worker:
 * 1. Fetches all available Pingdom probes
 * 2. Selects 30 probes from different regions
 * 3. Runs tests from all selected locations in parallel
 * 4. Returns performance metrics and analysis
 */

export interface Env {
  PINGDOM_API_TOKEN: string;
  TARGET_HOST: string;
  TARGET_PATH: string;
}

interface Probe {
  id: number;
  country: string;
  city: string;
  name: string;
  active: boolean;
  hostname?: string;
  ip?: string;
  countryiso?: string;
}

interface TestResult {
  probe_id: number;
  location: string;
  status: string;
  response_time?: number;
  error?: string;
}

async function getProbes(apiToken: string): Promise<Probe[]> {
  const response = await fetch("https://api.pingdom.com/api/3.1/probes", {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch probes: ${response.status} - ${errorText}`,
    );
  }

  const data: any = await response.json();
  return data.probes.filter((probe: Probe) => probe.active);
}

async function runSingleTest(
  apiToken: string,
  targetHost: string,
  targetPath: string,
  probeId: number,
): Promise<TestResult> {
  try {
    const url = new URL("https://api.pingdom.com/api/3.1/single");
    url.searchParams.append("host", targetHost);
    url.searchParams.append("type", "http");
    url.searchParams.append("url", targetPath);
    url.searchParams.append("probeid", probeId.toString());

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        probe_id: probeId,
        location: "unknown",
        status: "error",
        error: `API error: ${response.status} - ${errorText}`,
      };
    }

    const result: any = await response.json();
    return {
      probe_id: probeId,
      status: result.result.status,
      response_time: result.result.responsetime,
      location: result.result.probedesc,
    };
  } catch (error) {
    return {
      probe_id: probeId,
      location: "unknown",
      status: "error",
      error: error.message,
    };
  }
}

function selectProbes(probes: Probe[], targetCount: number = 30): number[] {
  // Define regions and desired count per region
  const regions: Record<string, { count: number; probes: number[] }> = {
    EU: { count: 0, probes: [] }, // Europe
    NA: { count: 0, probes: [] }, // North America
    SA: { count: 0, probes: [] }, // South America
    APAC: { count: 0, probes: [] }, // Asia/Pacific
    AF: { count: 0, probes: [] }, // Africa
    OTHER: { count: 0, probes: [] }, // Other regions
  };

  // Desired distribution (adjust as needed)
  const distribution = {
    EU: 8,
    NA: 8,
    SA: 3,
    APAC: 7,
    AF: 2,
    OTHER: 2,
  };

  // Categorize probes by region
  for (const probe of probes) {
    let region = "OTHER";

    if (
      /europe|germany|france|uk|spain|italy|netherlands|sweden|norway|finland|denmark|switzerland|belgium|austria|ireland|poland|czech|portugal|greece|hungary|romania|bulgaria|croatia|serbia|slovenia|slovakia|estonia|latvia|lithuania/i.test(
        probe.country,
      )
    ) {
      region = "EU";
    } else if (/united states|canada|mexico/i.test(probe.country)) {
      region = "NA";
    } else if (
      /brazil|argentina|chile|colombia|peru|venezuela|ecuador|bolivia|uruguay|paraguay|guyana|suriname/i.test(
        probe.country,
      )
    ) {
      region = "SA";
    } else if (
      /japan|china|australia|india|singapore|hong kong|thailand|malaysia|indonesia|philippines|vietnam|new zealand|south korea|taiwan/i.test(
        probe.country,
      )
    ) {
      region = "APAC";
    } else if (
      /south africa|egypt|nigeria|kenya|morocco|algeria|tunisia|ghana|ethiopia|tanzania|uganda|zimbabwe|botswana|namibia/i.test(
        probe.country,
      )
    ) {
      region = "AF";
    }

    regions[region].probes.push(probe.id);
  }

  // Select probes based on distribution
  const selectedProbes: number[] = [];

  // First pass: try to meet distribution goals
  for (const [region, target] of Object.entries(distribution)) {
    const available = regions[region].probes;
    const toSelect = Math.min(target, available.length);

    // Randomly select probes from this region
    const selected = available
      .sort(() => 0.5 - Math.random())
      .slice(0, toSelect);

    selectedProbes.push(...selected);
  }

  // Second pass: if we still need more probes, take from regions with extras
  if (selectedProbes.length < targetCount) {
    const remaining = targetCount - selectedProbes.length;
    const allProbeIds = probes.map((p) => p.id);
    const unselectedProbes = allProbeIds.filter(
      (id) => !selectedProbes.includes(id),
    );

    // Randomly select from remaining probes
    const additionalProbes = unselectedProbes
      .sort(() => 0.5 - Math.random())
      .slice(0, remaining);

    selectedProbes.push(...additionalProbes);
  }

  return selectedProbes.slice(0, targetCount);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // CORS headers for browser requests
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    // Handle OPTIONS request for CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);

      // Get Pingdom API token from environment or query param (for testing)
      let pingdomToken = env.PINGDOM_API_TOKEN;
      if (url.searchParams.has("token")) {
        pingdomToken = url.searchParams.get("token") || pingdomToken;
      }

      // Get target host and path from environment or query params
      let targetHost = env.TARGET_HOST;
      let targetPath = env.TARGET_PATH;

      if (url.searchParams.has("host")) {
        targetHost = url.searchParams.get("host") || targetHost;
      }

      if (url.searchParams.has("path")) {
        targetPath = url.searchParams.get("path") || targetPath;
      }

      // Validate required parameters
      if (!pingdomToken) {
        return new Response(
          JSON.stringify({ error: "Pingdom API token is required" }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      if (!targetHost) {
        return new Response(
          JSON.stringify({ error: "Target host is required" }),
          {
            status: 400,
            headers: corsHeaders,
          },
        );
      }

      // Get all active Pingdom probes
      const probes = await getProbes(pingdomToken);

      // Select 30 probes from different regions
      const selectedProbeIds = selectProbes(probes, 30);
      const selectedProbes = probes.filter((probe) =>
        selectedProbeIds.includes(probe.id),
      );

      // Create a mapping of probe IDs to country/city for better reporting
      const probeDetails = {};
      for (const probe of selectedProbes) {
        probeDetails[probe.id] = {
          name: probe.name,
          country: probe.country,
          city: probe.city,
        };
      }

      // Run tests in parallel from all selected probes
      const testPromises = selectedProbeIds.map((probeId) => {
        return runSingleTest(pingdomToken, targetHost, targetPath, probeId);
      });

      const results = await Promise.all(testPromises);

      // Add region information to results
      const resultsWithRegion = results.map((result) => {
        const probeId = result.probe_id;
        const probeInfo = probeDetails[probeId];
        let region = "Unknown";

        if (probeInfo) {
          const country = probeInfo.country;

          if (
            /europe|germany|france|uk|spain|italy|netherlands|sweden|norway|finland|denmark|switzerland|belgium|austria|ireland|poland|czech|portugal|greece|hungary|romania|bulgaria|croatia|serbia|slovenia|slovakia|estonia|latvia|lithuania/i.test(
              country,
            )
          ) {
            region = "Europe";
          } else if (/united states|canada|mexico/i.test(country)) {
            region = "North America";
          } else if (
            /brazil|argentina|chile|colombia|peru|venezuela|ecuador|bolivia|uruguay|paraguay|guyana|suriname/i.test(
              country,
            )
          ) {
            region = "South America";
          } else if (
            /japan|china|australia|india|singapore|hong kong|thailand|malaysia|indonesia|philippines|vietnam|new zealand|south korea|taiwan/i.test(
              country,
            )
          ) {
            region = "Asia/Pacific";
          } else if (
            /south africa|egypt|nigeria|kenya|morocco|algeria|tunisia|ghana|ethiopia|tanzania|uganda|zimbabwe|botswana|namibia/i.test(
              country,
            )
          ) {
            region = "Africa";
          }
        }

        return {
          ...result,
          region,
        };
      });

      // Calculate statistics
      const validResults = resultsWithRegion.filter(
        (r) => r.response_time !== undefined,
      );
      const responseTimes = validResults.map((r) => r.response_time!);

      let stats = {
        count: validResults.length,
        successful: validResults.filter((r) => r.status === "up").length,
        failed: validResults.filter((r) => r.status !== "up").length,
        average: 0,
        median: 0,
        min: 0,
        max: 0,
        p90: 0,
        p95: 0,
        p99: 0,
        by_region: {},
      };

      if (responseTimes.length > 0) {
        // Sort for percentile calculations
        const sorted = [...responseTimes].sort((a, b) => a - b);

        stats.average =
          responseTimes.reduce((sum, time) => sum + time, 0) /
          responseTimes.length;
        stats.median = sorted[Math.floor(sorted.length / 2)];
        stats.min = sorted[0];
        stats.max = sorted[sorted.length - 1];
        stats.p90 = sorted[Math.floor(sorted.length * 0.9)];
        stats.p95 = sorted[Math.floor(sorted.length * 0.95)];
        stats.p99 = sorted[Math.floor(sorted.length * 0.99)];

        // Calculate stats by region
        const regions = [...new Set(resultsWithRegion.map((r) => r.region))];
        for (const region of regions) {
          const regionResults = resultsWithRegion.filter(
            (r) => r.region === region && r.response_time !== undefined,
          );
          const regionTimes = regionResults.map((r) => r.response_time!);

          if (regionTimes.length > 0) {
            const regionSorted = [...regionTimes].sort((a, b) => a - b);

            stats.by_region[region] = {
              count: regionResults.length,
              successful: regionResults.filter((r) => r.status === "up").length,
              failed: regionResults.filter((r) => r.status !== "up").length,
              average:
                regionTimes.reduce((sum, time) => sum + time, 0) /
                regionTimes.length,
              median: regionSorted[Math.floor(regionSorted.length / 2)],
              min: regionSorted[0],
              max: regionSorted[regionSorted.length - 1],
            };
          }
        }
      }

      // Format response
      const response = {
        target: {
          host: targetHost,
          path: targetPath,
          url: `https://${targetHost}${targetPath}`,
        },
        timestamp: new Date().toISOString(),
        stats,
        results: resultsWithRegion,
      };

      return new Response(JSON.stringify(response, null, 2), {
        headers: corsHeaders,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  },
};
