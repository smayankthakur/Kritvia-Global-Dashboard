# Image for sandboxed jobs. No secrets, no network at runtime (enforced by the runner).
FROM python:3.12-slim
RUN pip install --no-cache-dir "numpy>=1.26" "statsforecast>=1.7"
COPY jobs/kritvia_jobs /opt/kritvia_jobs/kritvia_jobs
ENV PYTHONPATH=/opt/kritvia_jobs
# The runner starts jobs with `python -I`, which ignores PYTHONPATH; a .pth file in
# site-packages is still honoured, so register the jobs package there and check it imports.
RUN echo /opt/kritvia_jobs > "$(python -c 'import sysconfig; print(sysconfig.get_path("purelib"))')/kritvia_jobs.pth" \
    && python -I -c "import kritvia_jobs"
# Pre-compile numba kernels at build time so the read-only runtime doesn't need a cache dir.
RUN python -c "import numpy as np; from statsforecast.models import AutoETS; AutoETS(season_length=7).forecast(y=np.arange(40, dtype=float)%7+1, h=1)" || true
USER 65534:65534
