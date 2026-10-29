FROM node:22-alpine

WORKDIR /app

# We rely on Node 22's built-in global `WebSocket`, so no npm dependencies
# beyond the base image. Keeping the image dep-free also keeps it tiny
# (~50 MB) and removes the npm install step from the docker-compose build.
COPY bootstrap.mjs ./

# Run as non-root for hygiene; the script only opens a WebSocket out.
USER node

ENTRYPOINT ["node", "bootstrap.mjs"]
