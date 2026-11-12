import type { Env } from "../env";
import { refreshAlerts } from "../alerts";
import { checkEvents } from "../events";
import { startGithubJobs } from "../github-jobs";
import { evaluateStages } from "../stories";
import { checkTransitSchedule } from "../transit";
import { refreshWeather } from "../weather";

/** Forget what's no longer needed: rate-limit counters (some are keyed by IP address), expired sessions and reset links, old anonymous counts. */
async function tidyUp(env: Env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_throttle WHERE window_start < ?").bind(now - 864e5),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM password_resets WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM online_samples WHERE at < ?").bind(now - 90 * 864e5),
    env.DB.prepare("DELETE FROM story_traffic WHERE hour < ?").bind(Math.floor((now - 400 * 864e5) / 36e5)),
  ]);
}

export interface CronJob {
  /** The job's name in the cron-health feed. Changing one resets its failure count. */
  readonly key: string;
  readonly run: (env: Env) => Promise<unknown>;
}

/** What the cron runs every 30 minutes, in this order. Each failure is counted under the job's key (see watchCron). */
export const CRON_JOBS: readonly CronJob[] = [
  { key: "weather", run: refreshWeather },
  { key: "alerts", run: refreshAlerts },
  { key: "events", run: checkEvents },
  { key: "stages", run: evaluateStages },
  { key: "transit schedule", run: async () => checkTransitSchedule() },
  { key: "GitHub jobs", run: startGithubJobs },
  { key: "clean-up", run: tidyUp },
];
