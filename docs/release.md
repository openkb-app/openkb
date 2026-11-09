# Releases

A release is the `1.x` branch tagged `vX.Y.Z`. The Drupal module it installs
is released on [drupal.org/project/openkb](https://www.drupal.org/project/openkb)
as `X.Y.Z` — Drupal spells a pre-release without the `v` and without a dot
before the counter, so `v1.0.0-alpha1` here is `1.0.0-alpha1` there.

## Cutting one

Actions → `release` → **Run workflow**, `version` = `1.2.3`, without the `v`.
The module release `1.2.3` has to exist on drupal.org first — the workflow
checks for the tag and stops before it writes anything when it is missing.

It prepends the version's section to `CHANGELOG.md` with git-cliff and
`cliff.toml`, covering the commits since the previous tag; pins `drupal/openkb`
to `1.2.3` in `composer.json` and `composer.lock`, where `1.x` carries
`1.x-dev`; points the quickstart at the release — `OPENKB_TAG` in
`quickstart/.env` and the tag in the fetch URL both READMEs show — and stops
when either has moved; commits `release: v1.2.3.`, tags `v1.2.3` and pushes
both to `1.x`. The tag is what starts everything below.

Only the new section is written, so the sections below it are yours to correct
by hand between releases.

## What a version tag publishes

The `images` workflow builds the stack, installs the site on it and checks it
answers, then verifies the FrankenPHP base image's SLSA provenance against
`php/frankenphp` and pushes `ghcr.io/openkb-app/openkb-drupal` and
`ghcr.io/openkb-app/openkb-frontend` for `linux/amd64` and `linux/arm64` as
`1.2.3`, `1.2`, `1` and `latest`, each with a build-provenance attestation in
the registry. A pre-release tag (`v1.2.3-beta.1`) publishes that exact tag
only — no `1.2`, `1` or `latest`.

It then opens the GitHub release: the version's `CHANGELOG.md` section as the
notes, followed by how to run that version, marked pre-release when the
version carries a `-`. A tag whose version has no section in `CHANGELOG.md`
fails the job — the images are published, the release entry is not.

Check what arrived:

```sh
gh attestation verify oci://ghcr.io/openkb-app/openkb-drupal:1.2.3 --owner openkb-app
```

## Publishing a tag again

Actions → `images` → **Run workflow**, `version` = the existing tag
(`v1.2.3`). It builds that tagged tree again under the same tags, with the
base-image digests the tree pins, and rewrites the release entry's notes from
that tree's `CHANGELOG.md`. Once a version has image revisions, name the newest
one (`v1.2.3+r2`); the workflow refuses the plain version tag.

## Image revisions

A base-image patch (FrankenPHP, Node) reaches a released version as an image
revision: the same version, rebuilt on the base images `1.x` pins. The app, both
images and the drupal.org module keep their version.

What calls for one: the daily `Image scan` workflow on openkb-app/openkb. Its
Trivy jobs scan the published images for fixed HIGH and CRITICAL
vulnerabilities in OS packages and app dependencies; each build runs
`apk upgrade`, so a rebuild on a moved base pin picks up Alpine's current
fixes. Trivy never sees
FrankenPHP's own advisories: they are repository advisories on php/frankenphp,
and the binary carries no FrankenPHP module version to match. Its
`base images` job covers them: it fails when php/frankenphp has an advisory
patched after the FrankenPHP pin, or Node has a security release of the
pinned major newer than the Node pin. Dependabot opens the bump PR, with no
cooldown for base images.

1. Merge the base-image bump into `1.x` and sync it.
2. Actions → `revision` → **Run workflow**, `version` = `1.2.3`.

The workflow:

- makes `release/1.2.3` from `v1.2.3`, or continues it for a later revision
- sets each `image:tag@sha256:…` in `docker/*/Dockerfile` to the tag and
  digest `1.x` pins for the same image and major (Node 22, FrankenPHP 1 on
  PHP 8.3)
- stops when that changes nothing
- adds an `Image revision rN` part to the version's `CHANGELOG.md` section
- commits `release: v1.2.3+rN.`, then tags and pushes `v1.2.3+rN`

`+rN` is semver build metadata: the same version, another build. `images`
publishes it as `1.2.3-rN` (Docker tags carry no `+`). It moves `1.2.3`, `1.2`,
`1` and `latest` onto it, as the `v1.2.3` tag would, and updates the `v1.2.3`
release entry. A site on `OPENKB_TAG=1.2.3` gets the patch with
`docker compose pull`; `OPENKB_TAG=1.2.3-rN` pins that build.

A stable version gets revisions only while it is the newest stable one,
because its floating tags move; any pre-release can get one. The
revision note lives on `release/1.2.3` and in the release entry, not in the
`CHANGELOG.md` of `1.x`.

## Development image

Every push to `1.x` publishes the branch head as
`ghcr.io/openkb-app/openkb-drupal:1.x` and
`ghcr.io/openkb-app/openkb-frontend:1.x`, for `linux/amd64` only, after the
same smoke run and base-image check a release goes through. Each build also
carries `sha-<short>`; neither `latest` nor a semver tag moves.

```sh
OPENKB_TAG=1.x            # follows the branch
OPENKB_TAG=sha-1a2b3c4    # one build of it, pinned
```

The `drupal/openkb` inside a development image is the commit `composer.lock`
pins, not what `1.x-dev` resolves to at build time: the image installs from the
lock.

## Pinning a version

A self-hoster names the release in `.env` instead of building:

```sh
OPENKB_TAG=1.2.3
```

```sh
docker compose pull
docker compose up -d
```

The `drupal` container installs the site on a first boot. On an existing site
whose database updates the new images left pending, it holds the site until an
administrator has run `<drupal url>/update.php`. `OPENKB_IMAGE_PREFIX` points
the same stack at another registry; unset, `OPENKB_TAG` is `dev`, the name
`docker compose build` writes locally.
