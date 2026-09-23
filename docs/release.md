# Releases

A release is the `1.x` branch tagged `vX.Y.Z`. The Drupal module it installs
is released on [drupal.org/project/openkb](https://www.drupal.org/project/openkb)
as `X.Y.Z` — Drupal spells a pre-release without the `v` and without a dot
before the counter, so `v1.0.0-alpha1` here is `1.0.0-alpha1` there.

## What a version tag publishes

The `images` workflow builds the stack, installs the site on it and checks it
answers, then verifies the FrankenPHP base image's SLSA provenance against
`php/frankenphp` and pushes `ghcr.io/openkb-app/openkb-drupal` and
`ghcr.io/openkb-app/openkb-frontend` for `linux/amd64` and `linux/arm64` as
`1.2.3`, `1.2`, `1` and `latest`, each with a build-provenance attestation in
the registry. A pre-release tag (`v1.2.3-beta.1`) publishes that exact tag
only — no `1.2`, `1` or `latest`.

The release tree pins `drupal/openkb` to the module release of the same
version, so the images of `1.2.3` carry the `1.2.3` module.

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
(`v1.2.3`). It builds that tagged commit again under the same tags — how a
base-image patch reaches a released version — and rewrites the release entry's
notes from that tree's `CHANGELOG.md`.

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

The `drupal/openkb` inside the image is the commit `composer.lock` pins, not
what `1.x-dev` resolves to at build time: the image installs from the lock.

## Pinning a version

A self-hoster names the release in `.env` instead of building:

```sh
OPENKB_TAG=1.2.3
```

```sh
docker compose pull
docker compose up -d
docker compose exec drupal openkb-install   # first run only; it destroys an existing site
```

On an existing site, `docker compose exec drupal openkb-update` replaces the
`openkb-install` line. `OPENKB_IMAGE_PREFIX` points the same stack at another
registry; unset, `OPENKB_TAG` is `dev`, the name `docker compose build` writes
locally.
