# Releases

A release is a git tag `vX.Y.Z` on `1.x` of the public repository
([openkb-app/openkb](https://github.com/openkb-app/openkb)). Its `images`
workflow publishes the two images to GHCR:
`ghcr.io/openkb-app/openkb-drupal` and `ghcr.io/openkb-app/openkb-frontend`.

## Cutting one

```sh
git tag -a v1.2.3 -m "OpenKB 1.2.3"
git push origin v1.2.3
```

The run builds the stack, installs the site on it and checks it answers, then
verifies the FrankenPHP base image's SLSA provenance against `php/frankenphp`
and pushes both images for `linux/amd64` and `linux/arm64` as `1.2.3`, `1.2`,
`1` and `latest`, each with a build-provenance attestation in the registry. A
pre-release tag (`v1.2.3-beta.1`) publishes that exact tag only — no `1.2`,
`1` or `latest`.

Check what arrived:

```sh
gh attestation verify oci://ghcr.io/openkb-app/openkb-drupal:1.2.3 --owner openkb-app
```

## Publishing a tag again

Actions → `images` → **Run workflow**, `version` = the existing tag
(`v1.2.3`). It builds that tagged commit again under the same tags — how a
base-image patch reaches a released version.

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

The `drupal/openkb` inside the image is the commit `composer.lock` pins here,
not what `1.x-dev` resolves to at build time: the lock is re-resolved when the
tree is synced, and the image installs from it.

A GHCR package takes its visibility from its first push, so the first build of
each package has to run after the repository is public — otherwise both
packages land private and have to be flipped by hand.

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
