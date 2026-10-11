# Syntax deliberately sticks to the standard Dockerfile frontend so the image
# can be built by ordinary Docker Engine without BuildKit-only features.
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build && npm test

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PATH=/app/.venv/bin:$PATH

WORKDIR /app

# uv consumes the checked-in lock, so dependency resolution is reproducible.
# Use the official Debian HTTPS repository for remote builds.
RUN sed -i \
      -e 's|http://deb.debian.org|https://deb.debian.org|g' \
      /etc/apt/sources.list.d/debian.sources \
    && pip install --no-cache-dir uv==0.10.6
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project \
    && playwright install --with-deps chromium \
    && groupadd --gid 10001 rabbit \
    && useradd --create-home --uid 10001 --gid rabbit rabbit \
    && chown -R rabbit:rabbit /app /ms-playwright

RUN mkdir -p /app/provider-secrets \
    && chmod 700 /app/provider-secrets \
    && chown rabbit:rabbit /app/provider-secrets

COPY --chown=rabbit:rabbit alembic.ini ./
COPY --chown=rabbit:rabbit alembic ./alembic
COPY --chown=rabbit:rabbit src ./src
COPY --from=frontend-build --chown=rabbit:rabbit /frontend/dist ./frontend/dist

USER rabbit
EXPOSE 8000

CMD ["python", "-m", "rabbit_hole.runtime.server"]
