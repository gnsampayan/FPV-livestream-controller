# nginx image with the web app baked in.
#
# Build context is the REPOSITORY ROOT (not server/nginx), because the image
# needs both web/ (the React app) and server/nginx/ (the config):
#
#   docker build -f server/nginx/Dockerfile \
#       --build-arg VITE_AUTH_TOKEN=<same value as CONTROL_AUTH_TOKEN> \
#       -t fpv-nginx-web .
#
# Shipping the build inside the image (instead of bind-mounting web/dist from
# the host) means the site and its nginx config always deploy and roll back
# together under one image tag, and the server needs no Node toolchain.

# ---- Stage 1: build the web app -------------------------------------------
FROM node:20-alpine AS web-build

WORKDIR /web

# Install dependencies first so this layer is cached until the lockfile changes.
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./

# Vite bakes VITE_* variables into the bundle at build time. This is the same
# shared secret the browser presents to the control relay, so it is visible in
# DevTools by design (see web/.env.example); it is not a server-side secret.
ARG VITE_AUTH_TOKEN
ENV VITE_AUTH_TOKEN=${VITE_AUTH_TOKEN}

RUN npm run build

# ---- Stage 2: nginx serving the build -------------------------------------
FROM nginx:alpine

# The per-host server blocks are rendered from /etc/nginx/templates by the
# entrypoint (envsubst of ${SERVER_DOMAIN}) when the container starts.
COPY server/nginx/nginx.conf /etc/nginx/nginx.conf
COPY server/nginx/templates /etc/nginx/templates
COPY --from=web-build /web/dist /usr/share/nginx/html
