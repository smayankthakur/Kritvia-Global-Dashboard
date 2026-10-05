# Build from the monorepo root:  docker build -f apps/api/Dockerfile -t kritvia-api .
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# Local OCR (Tesseract with Hindi); loan documents are never sent to a hosted OCR API.
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-hin \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/api/pyproject.toml ./
COPY apps/api/kritvia_api ./kritvia_api
RUN pip install ".[ocr]"
COPY apps/api/migrations ./migrations
COPY infra/litellm/tiers.yaml ./tiers.yaml
ENV TIERS_CONFIG_PATH=/app/tiers.yaml KRITVIA_MIGRATIONS_DIR=/app/migrations
RUN useradd --uid 10001 --no-create-home kritvia
USER kritvia
EXPOSE 8000
CMD ["uvicorn", "kritvia_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-server-header"]
