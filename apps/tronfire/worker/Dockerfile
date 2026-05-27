FROM docker:27-cli AS docker-cli

FROM node:20-bookworm-slim
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openssl ca-certificates bash procps net-tools xz-utils findutils \
    libstdc++6 libtommath1 libncurses6 libtinfo6 \
  && ln -sf /lib/x86_64-linux-gnu/libncurses.so.6 /lib/x86_64-linux-gnu/libncurses.so.5 \
  && ln -sf /lib/x86_64-linux-gnu/libtinfo.so.6 /lib/x86_64-linux-gnu/libtinfo.so.5 \
  && if [ -e /usr/lib/x86_64-linux-gnu/libtommath.so.1 ]; then ln -sf /usr/lib/x86_64-linux-gnu/libtommath.so.1 /usr/lib/x86_64-linux-gnu/libtommath.so.0; fi \
  && mkdir -p /opt \
  && rm -rf /var/lib/apt/lists/*
COPY worker/package*.json ./
RUN npm install
COPY backend/prisma ./prisma
RUN npx prisma generate
COPY worker/src ./src
COPY backend/src/wait-for-postgres.js ./src/wait-for-postgres.js
CMD ["sh", "-c", "node src/wait-for-postgres.js && node src/worker.js"]
