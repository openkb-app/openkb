# Monitoring

`recipes/openkb_recipe_monitoring` gives an environment a health report: the
[monitoring](https://www.drupal.org/project/monitoring) module runs a fixed set
of sensors, and [ohdear_integration](https://www.drupal.org/project/ohdear_integration)
serves their results as the JSON document [ohdear.app](https://ohdear.app) polls.

The recipe applies with the others (`phapp init`, `phapp update`), so every
environment has the endpoint. Wiring an environment *into* ohdear.app is the
manual step below.

## The endpoint

```
GET /json/oh-dear-health-check-results?oh-dear-health-check-secret=<secret>
```

The secret is per environment, set at `/admin/config/system/ohdear-settings`.
Anyone holding the `monitoring reports` permission reaches the same document
with a session instead, which is how `/admin/reports/monitoring` and the e2e
check read it. Without either, the endpoint answers 403 — it exposes the status
report, module versions and session counts.

## Sensors

Each file in the recipe's `config/` directory is one sensor. A recipe installs a
module without its config entities, so that directory *is* the sensor set — the
monitoring module's own defaults never reach the site, and adding a sensor means
adding a file.

| Sensor | Fails when |
|---|---|
| `requirements_errors` | The Drupal status report has any error. |
| `requirements_warnings` | Never — warns above 0. Update and coverage requirements are excluded; the update sensors report those. |
| `dblog_event_severity_error` | More than 5 watchdog errors in the last two hours (warns above 1). |
| `search_api_kb_chunks` | More than 10 pages are waiting to be embedded into the chunk index (warns above 2). |
| `disk_usage`, `tmp_disk_usage` | The public-files disk is above 95% (warns above 80), or `/tmp` is above 95%. |
| `temporary_files_usages` | Never — warns on any file left temporary. |
| `core_maintenance_mode`, `system_load_average`, `update_core`, `update_contrib`, `user_sessions_all` | Never — reported for context. |

Errors fail, warnings report. A status-report warning is usually a pending
module update or a development-mode setting: worth reading, not worth stopping
a deployment for.

`update.settings` is configured alongside: daily checks, security-level
notification threshold, no per-site mail recipient — ohdear.app carries the
alerting.

## The build gate

`tests/playwright/tests/monitoring.spec.ts` reads the endpoint on the deployed
CI environment and fails the build on any check that reports `failed`. That is
what makes a status-report error — a missing config sync directory, unset
trusted host patterns, an insecure release — a red build rather than something
found by opening `/admin/reports/status` by hand.

One sensor is exempt: `dblog_event_severity_error`. The suite provokes errors on
purpose, so on CI that sensor reports the suite back to itself.

## Wiring an environment into ohdear.app

The API token is shared across drunomics sites; read it off an already-wired
site (`drush cget ohdear_integration.settings`) rather than minting a new one.

1. Keep `https://<drupal-host>/admin/config/system/ohdear-settings` open and put
   the API key in.
2. At <https://ohdear.app/monitors>, add a **Website** monitor for
   `https://<drupal-host>/user/login`. Under advanced options set a friendly
   name, and enable every check except Sitemap.
3. Edit the saved monitor. Its numeric URL segment is the **Site ID** — copy it
   into the Drupal settings form.
   - *Application health → Settings*: copy the **health report secret** into the
     Drupal form, and set the health report URL to
     `https://<drupal-host>/json/oh-dear-health-check-results?oh-dear-health-check-secret=<secret>`.
   - *Scheduled tasks*: add a simple task monitor named `Cron`, frequency 10,
     grace time 10, and copy its **ping URL** into the Drupal form.
4. Save the Drupal settings form once every field is filled.

The frontend is a second monitor on `https://<frontend-host>` with every check
except Application health — Drupal answers that one for the whole stack.
