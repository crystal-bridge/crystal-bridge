# The hub: `docker run -d -p 7700:7700 -v crystal-bridge:/data ghcr.io/crystal-bridge/airship`. It defaults to token login,
# the only one safe on a reachable address. `docker logs` shows a one-time setup code for making the first login in the
# browser, or use `docker exec <container> crystal-bridge-airship token add me`. Put HTTPS in front of it. Kingdoms don't run in here: they run on the machines with your code.
FROM node:22-slim AS build
WORKDIR /src
RUN npm install --global pnpm@12.16.1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @crystal-bridge/airship build
RUN pnpm --filter @crystal-bridge/airship pack --pack-destination /out

FROM node:22-slim
WORKDIR /app
COPY --from=build /out/ /tmp/out/
RUN npm init --yes >/dev/null \
  && npm install --omit=dev --no-audit --no-fund /tmp/out/*.tgz \
  && rm -rf /tmp/out \
  && mkdir /data \
  && chown node:node /data
ENV AIRSHIP_AUTH=token AIRSHIP_HOST=0.0.0.0 AIRSHIP_DATA=/data PATH=/app/node_modules/.bin:$PATH
USER node
VOLUME /data
EXPOSE 7700
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:' + (process.env.AIRSHIP_PORT ?? 7700) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["crystal-bridge-airship"]
