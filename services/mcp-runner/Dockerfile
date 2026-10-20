# Kritvia MCP runner: hosts reviewed stdio MCP servers (npm / PyPI / container images) for the App store, one
# gVisor container per installed app. Needs the host Docker socket (like services/sandbox) and sits on two
# networks: the stack's default one (the API and workers call it) and the internal mcp-sandbox network (the app
# containers reach the internet only through its egress proxy on port 8301). See README.md.
FROM python:3.12-slim
RUN apt-get update \
    && (apt-get install -y --no-install-recommends docker-cli || apt-get install -y --no-install-recommends docker.io) \
    && rm -rf /var/lib/apt/lists/* && docker --version
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
WORKDIR /app
COPY app.py guard.py ./
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8300 8301
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8300/healthz')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8300", "--workers", "1"]
