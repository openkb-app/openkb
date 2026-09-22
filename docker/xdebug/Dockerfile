# Local layer on the release image, for docker-compose.xdebug.yml.
ARG OPENKB_DRUPAL_IMAGE
FROM ${OPENKB_DRUPAL_IMAGE}

USER root
RUN install-php-extensions xdebug
COPY 99-xdebug-php.ini ${PHP_INI_DIR}/conf.d/
USER www-data
