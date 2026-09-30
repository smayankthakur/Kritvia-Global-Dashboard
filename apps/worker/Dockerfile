# Build from the monorepo root:  docker build -f apps/worker/Dockerfile -t kritvia-worker .
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-hin \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/api/pyproject.toml ./api/pyproject.toml
COPY apps/api/kritvia_api ./api/kritvia_api
RUN pip install "./api[ocr]"
COPY apps/worker/kritvia_worker ./kritvia_worker
COPY infra/litellm/tiers.yaml ./tiers.yaml
ENV TIERS_CONFIG_PATH=/app/tiers.yaml
RUN useradd --uid 10001 --no-create-home kritvia
USER kritvia
CMD ["arq", "kritvia_worker.main.WorkerSettings"]
