# Build stage
FROM node:18-alpine AS build

# Set current working directory
WORKDIR /community-server

# Copy the dockerfile's context's community server files
COPY . .

# Install and build the Solid community server
RUN npm ci && npm run build

# The runtime stage only needs the production dependencies;
# --ignore-scripts prevents the root prepare script (a full build) from running
RUN npm prune --omit=dev --ignore-scripts



# Runtime stage
FROM node:18-alpine

# Add contact informations for questions about the container
LABEL maintainer="Solid Community Server Docker Image Maintainer <thomas.dupont@ugent.be>"

# Use tini as PID 1 to reap zombies and forward signals such as the SIGTERM from `docker stop` to node
RUN apk add --no-cache tini

# Container config & data dir for volume sharing
# Defaults to filestorage with /data directory (passed through CMD below)
# Owned by the non-root node user so mounted volumes stay writable
RUN mkdir -p /config /data && chown node:node /config /data

# Set current directory
WORKDIR /community-server

# Copy runtime files from build stage
# Application files stay root-owned so the runtime user cannot modify them
COPY --from=build /community-server/package.json .
COPY --from=build /community-server/bin ./bin
COPY --from=build /community-server/config ./config
COPY --from=build /community-server/dist ./dist
COPY --from=build /community-server/node_modules ./node_modules
COPY --from=build /community-server/templates ./templates

# Informs Docker that the container listens on the specified network port at runtime
EXPOSE 3000

# Run as the non-root node user (uid 1000, gid 1000) provided by the base image
USER node

ENV NODE_ENV=production

# By default run in filemode (overriden if passing alternative arguments or env vars)
ENV CSS_CONFIG=config/file.json
ENV CSS_ROOT_FILE_PATH=/data

# The health check follows CSS_PORT; override it when the port is configured through other means
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.CSS_PORT ?? 3000) + '/.well-known/css/health').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

# Set command run by the container
ENTRYPOINT [ "/sbin/tini", "--", "node", "bin/server.js" ]
