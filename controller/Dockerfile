# Cloud replica image (GH_ROLE=cloud). Build from the repository root:
#   docker build -f controller/Dockerfile -t greenhouse-cloud .
# Build the web app first (cd app && npm ci && npm run build) so app/dist is included.
FROM python:3.11-slim
WORKDIR /opt/greenhouse
COPY contract/ contract/
COPY controller/ controller/
RUN pip install --no-cache-dir ./controller
COPY app/dist/ app/dist/
ENV GH_ROLE=cloud \
    GH_REGISTRY=/opt/greenhouse/contract/registry.yaml \
    GH_MQTT_HOST=memory \
    GH_WEB_ROOT=/opt/greenhouse/app/dist
WORKDIR /opt/greenhouse/controller
EXPOSE 8000
CMD ["sh", "-c", "greenhouse init-db && greenhouse api --host 0.0.0.0 --port 8000"]
