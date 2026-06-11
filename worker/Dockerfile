FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv ca-certificates \
  && python3 -m venv /opt/ia-venv \
  && /opt/ia-venv/bin/pip install --no-cache-dir internetarchive \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/ia-venv/bin:${PATH}"
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

USER node
EXPOSE 8080
CMD ["npm", "start"]

