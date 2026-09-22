# syntax=docker/dockerfile:1
# openkb-drupal: FrankenPHP serving Drupal on :8080, plus drush and composer.

FROM dunglas/frankenphp:1-php8.3-alpine@sha256:7632cbed485bb9d92cf84ee1ae00e4e0ba96f7dc3d19ac7ce726db4ec725c33a AS base

# pdo_pgsql: a hard requirement of drupal/ai_provider_amazeeio.
RUN install-php-extensions apcu gd intl opcache pdo_mysql pdo_pgsql zip \
 && apk add --no-cache bash curl git mariadb-client netcat-openbsd openssl patch

COPY --from=composer:2@sha256:a5f59b9fd2faf31218632be4809dc6491761085e8064c31dc3b84378c48c248b /usr/bin/composer /usr/local/bin/composer

WORKDIR /app


FROM base AS build

ENV COMPOSER_ALLOW_SUPERUSER=1

COPY composer.json composer.lock ./
COPY patches patches/
# composer.json autoloads a class from here.
COPY scripts/composer scripts/composer/
RUN --mount=type=cache,target=/root/.composer/cache \
    composer install --no-dev --optimize-autoloader --no-interaction --no-progress \
 && rm -rf patches

COPY web web/
# What openkb-install and openkb-update run.
COPY scripts/site-install.sh scripts/site-update.sh scripts/ensure-oauth-keys.sh scripts/setup-collab-oauth.sh scripts/

# - files/ holds everything that persists: public, private, config sync.
# - web/files and config/sync point into it.
RUN mkdir -p files/public/translations files/private files/config/sync config \
 && ln -sfn ../files/public web/files \
 && ln -sfn ../files/config/sync config/sync \
 && chmod 444 web/sites/default/settings.php


FROM base

RUN cp "${PHP_INI_DIR}/php.ini-production" "${PHP_INI_DIR}/php.ini"
COPY docker/drupal/php.ini ${PHP_INI_DIR}/conf.d/zz-openkb.ini
COPY docker/drupal/Caddyfile /etc/frankenphp/Caddyfile
COPY --from=build /app /app
COPY --chmod=755 docker/drupal/openkb-install docker/drupal/openkb-update /usr/local/bin/

# - www-data owns only what it writes: the files volume and Caddy's state.
# - :8080 needs no capability, so the binary carries none.
RUN chown -R www-data:www-data /app/files /data/caddy /config/caddy \
 && setcap -r /usr/local/bin/frankenphp

# vendor/bin comes from the image, or from a bind-mounted checkout in dev.
ENV PATH="/app/vendor/bin:${PATH}" \
    SERVER_NAME=":8080"

EXPOSE 8080
USER www-data

# A redirect to the installer counts: the site is served, just not installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:8080/user/login || exit 1

# Last, so a new revision rebuilds no layer above.
ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="openkb-drupal" \
      org.opencontainers.image.description="OpenKB backend: Drupal 11 on FrankenPHP, with drush." \
      org.opencontainers.image.source="https://github.com/openkb-app/openkb" \
      org.opencontainers.image.licenses="GPL-2.0-or-later" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
