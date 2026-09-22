# ADR 0018: Upstream-maintained base images only

Status: accepted (fago, 21.09.2026); pinned by
[OKB-330](https://drunomics.youtrack.cloud/issue/OKB-330), practices in
[OKB-41](https://drunomics.youtrack.cloud/issue/OKB-41)

## Context

- The Docker images are the public setup path (ADR 0007). A self-hoster
  who audits them audits every layer beneath ours, and every layer we
  did not build is one more upstream we have to justify.
- "Docker Official Image" is a Docker Hub programme (the `library/`
  namespace), not a synonym for "maintained by the project". The
  OpenSearch image is a Verified Publisher image, not an Official one.
  FrankenPHP's image is published from a personal Hub namespace,
  although its source is the `php/frankenphp` repository, and it
  carries SLSA provenance signed by that repository's build workflow
  (verified with cosign, 2026-09-21; command in OKB-330).

## Decision

**Every own image builds directly on an upstream-maintained base image,
pinned by digest.** Upstream-maintained means one of:

- a Docker Official Image (`php`, `node`, `mariadb`, `caddy`, `nginx`);
- a Verified Publisher image of the project itself
  (`opensearchproject/opensearch`);
- the project's own image whose build provenance the publishing
  pipeline verifies against the project's repository identity
  (`dunglas/frankenphp` against `php/frankenphp`).

No third-party repackaging layer. Vanilla images (MariaDB, OpenSearch)
are used as published, configured through their documented environment.

## Consequences

- One Dockerfile set serves self-hosting, local development and CI.
- A base outside `library/` is acceptable only with a provenance check in
  the pipeline; a base that cannot be verified is not used, whatever its
  badge.
- A tag is mutable, a digest is not: the pin makes a build reproducible
  and keeps the provenance check meaningful. The tag beside it names the
  line we follow.
- Dependabot moves the pinned digests when upstream re-pushes a tag, as
  one grouped PR that CI tests before it merges. A tag change (PHP 8.4,
  Node 24) is a decision, not an update.
- MariaDB and OpenSearch are referenced by tag only, so a self-hoster
  gets their patches with `docker compose pull`.
