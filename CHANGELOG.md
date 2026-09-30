# Changelog

## [1.0.0-beta2] - 2026-09-30

### Fixes

- The quickstart OpenSearch ignores the disk watermarks, so a nearly full host disk leaves the indexes writable.
- Demo pages carry the site manager recipe their siteadmin account needs.
- Unpublished pages are readable by space editors only.
- The module tests pass cspell, phpstan and phpunit on drupal.org.

### Improvements

- The sync scripts start from the published branch head, push with --push, and name the missing module sync.

## [1.0.0-beta1] - 2026-09-23

## [1.0.0-alpha3] - 2026-09-23

### Fixes

- Start the cron service after drupal, so one container fills the files volume.
- A keyless install finishes: the chunk re-feed needs a key.

## [1.0.0-alpha3] - 2026-09-23

### Fixes

- Start the cron service after drupal, so one container fills the files volume.

## [1.0.0-alpha3] - 2026-09-23

## [1.0.0-alpha2] - 2026-09-23

### Features

- Run Drupal cron from a cron service with supercronic, not automated_cron.
- Auto-install on first boot, a holding page until ready, and update.php once after an image update.
- The user guide ships its first screenshot.

### Fixes

- Make the drupal.org pipeline of project/openkb green.
- The update hold stops making the site uncacheable, and a boot never installs over a database.

### Documentation

- The public README carries requirements, installation, AI setup and updates.

## [1.0.0-alpha1] - 2026-09-23


