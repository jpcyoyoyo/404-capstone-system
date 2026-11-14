# Cloud replica image (GH_ROLE=cloud). Build from the repository root:
#   docker build -f controller/Dockerfile -t greenhouse-cloud .
# The web app is built inside the image (stage 1), so app/dist does not have to exist or be
# committed. Used by deploy/cloud/compose.yaml (VPS) and by Railway (railway.json at the root).

# ── Stage 1: build the web app (app/dist) ──────────────────────────────
FROM node:22-slim AS web
WORKDIR /src/app
# Cypress end-to-end tests are not run here; skip its 500 MB binary download.
ENV CYPRESS_INSTALL_BINARY=0
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/ ./
RUN npm run build

# ── Stage 2: the API ───────────────────────────────────────────────────
FROM python:3.11-slim
WORKDIR /opt/greenhouse
COPY contract/ contract/
COPY controller/ controller/
RUN pip install --no-cache-dir ./controller
COPY --from=web /src/app/dist/ app/dist/
ENV GH_ROLE=cloud \
    GH_REGISTRY=/opt/greenhouse/contract/registry.yaml \
    GH_MQTT_HOST=memory \
    GH_WEB_ROOT=/opt/greenhouse/app/dist
WORKDIR /opt/greenhouse/controller
EXPOSE 8000
# Railway sets PORT; elsewhere (compose + Caddy) the API stays on 8000.
CMD ["sh", "-c", "greenhouse init-db && exec greenhouse api --host 0.0.0.0 --port ${PORT:-8000}"]
