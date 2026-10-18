# Kritvia browser: headless Chromium for the browser agent (services/browser/app.py).
# No secrets in the image; BROWSER_TOKEN comes from the environment. Runs as an unprivileged user with a
# read-only root (see infra/docker-compose.yml); Chromium's traffic goes through guard.EgressProxy.
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache \
    && useradd --system --uid 10001 --home /home/browser --create-home browser
WORKDIR /app
COPY app.py guard.py snapshot.js ./
USER 10001:10001
EXPOSE 8200
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8200/healthz')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8200", "--workers", "1"]
