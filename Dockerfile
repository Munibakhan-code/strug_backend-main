# syntax=docker/dockerfile:1
FROM node:20-slim

RUN apt-get update && \
    apt-get install -y openssl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Lockfile-based install so BuildKit/GHA cache hits when deps are unchanged.
COPY package.json package-lock.json ./
# Skip lifecycle scripts (ChainDrop preinstall). Rebuild only native/binary packages.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm rebuild bcrypt sharp ffmpeg-static geoip-lite

COPY . .
# prisma CLI is a devDependency; download just for generate (same idea as prior `npx -y`).
RUN npx -y prisma@6.19.2 generate

ENV PORT=80
EXPOSE 80

# The app writes rotating Winston logs under ./logs; create it with the right owner before
# dropping privileges, otherwise the first write fails as a non-root user.
RUN mkdir -p /app/logs && chown -R node:node /app/logs

# Run as the unprivileged `node` user that this base image already ships. The container
# previously ran everything as root, so any RCE in a dependency started with full container
# privileges. Placed after all root-owned build steps.
USER node

# Container-level liveness. Hits the process-only probe (no DB/Redis I/O), so a dependency
# outage degrades readiness rather than causing the runtime to kill an otherwise healthy
# replica. Orchestrators that manage probes themselves (Azure Container Apps) override this;
# it makes `docker run` and compose behave correctly too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
