# The runner needs the host Docker socket to start job containers. It is the ONLY
# service with that access; it is reachable only on the internal network.
FROM python:3.12-slim
# Only the docker CLI is needed (the daemon is the host's). Debian 13 ships it as docker-cli;
# docker.io no longer includes the binary. Fail the build if it is missing.
RUN apt-get update \
    && (apt-get install -y --no-install-recommends docker-cli || apt-get install -y --no-install-recommends docker.io) \
    && rm -rf /var/lib/apt/lists/* && docker --version
RUN pip install --no-cache-dir "fastapi>=0.115" "uvicorn>=0.30"
WORKDIR /app
COPY runner/app.py ./app.py
EXPOSE 8100
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100"]
