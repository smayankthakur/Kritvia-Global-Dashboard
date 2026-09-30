FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "pyannote.audio>=3.1" "fastapi>=0.115" "uvicorn>=0.30" "python-multipart>=0.0.9"
WORKDIR /app
COPY app.py .
RUN useradd --uid 10001 -m diar
USER diar
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8200"]
