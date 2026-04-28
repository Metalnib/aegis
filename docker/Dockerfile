# ── Stage 1: build Synopsis binary ──────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS synopsis-build
WORKDIR /src
COPY --from=build-context dotnet-episteme-skills/src/synopsis ./synopsis
RUN dotnet publish synopsis/Synopsis/Synopsis.csproj \
      -c Release -r linux-x64 --self-contained true \
      -o /out/synopsis

# ── Stage 2: build Aegis TypeScript packages ─────────────────────────────────
FROM node:22-slim AS ts-build
RUN npm install -g pnpm
WORKDIR /aegis
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/sdk/package.json            ./packages/sdk/
COPY packages/core/package.json           ./packages/core/
COPY packages/agent/package.json          ./packages/agent/
COPY packages/adapter-github/package.json ./packages/adapter-github/
COPY packages/adapter-gitlab/package.json ./packages/adapter-gitlab/
COPY packages/adapter-slack/package.json  ./packages/adapter-slack/
COPY packages/adapter-gchat/package.json  ./packages/adapter-gchat/
COPY packages/cli/package.json            ./packages/cli/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/ ./packages/
RUN pnpm build

# ── Stage 3: copy skills from episteme-skills ─────────────────────────────────
FROM scratch AS skills
COPY --from=build-context dotnet-episteme-skills/skills/ /skills/

# ── Stage 4: final image ─────────────────────────────────────────────────────
FROM node:22-slim
RUN npm install -g pnpm && apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /aegis
COPY --from=ts-build /aegis/package.json ./
COPY --from=ts-build /aegis/pnpm-workspace.yaml ./
COPY --from=ts-build /aegis/packages/sdk/package.json            ./packages/sdk/
COPY --from=ts-build /aegis/packages/core/package.json           ./packages/core/
COPY --from=ts-build /aegis/packages/agent/package.json          ./packages/agent/
COPY --from=ts-build /aegis/packages/adapter-github/package.json ./packages/adapter-github/
COPY --from=ts-build /aegis/packages/adapter-gitlab/package.json ./packages/adapter-gitlab/
COPY --from=ts-build /aegis/packages/adapter-slack/package.json  ./packages/adapter-slack/
COPY --from=ts-build /aegis/packages/adapter-gchat/package.json  ./packages/adapter-gchat/
COPY --from=ts-build /aegis/packages/cli/package.json            ./packages/cli/
COPY --from=ts-build /aegis/packages/sdk/dist            ./packages/sdk/dist/
COPY --from=ts-build /aegis/packages/core/dist           ./packages/core/dist/
COPY --from=ts-build /aegis/packages/agent/dist          ./packages/agent/dist/
COPY --from=ts-build /aegis/packages/adapter-github/dist ./packages/adapter-github/dist/
COPY --from=ts-build /aegis/packages/adapter-gitlab/dist ./packages/adapter-gitlab/dist/
COPY --from=ts-build /aegis/packages/adapter-slack/dist  ./packages/adapter-slack/dist/
COPY --from=ts-build /aegis/packages/adapter-gchat/dist  ./packages/adapter-gchat/dist/
COPY --from=ts-build /aegis/packages/cli/dist            ./packages/cli/dist/

RUN pnpm install --prod --frozen-lockfile

COPY --from=synopsis-build /out/synopsis /opt/aegis/bin/synopsis
COPY --from=skills /skills /opt/aegis/skills/
COPY SOUL.md /opt/aegis/SOUL.md
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/healthcheck.sh /healthcheck.sh
RUN chmod +x /entrypoint.sh /healthcheck.sh /opt/aegis/bin/synopsis

RUN mkdir -p /workspace /var/lib/aegis /var/run/aegis
VOLUME ["/workspace", "/var/lib/aegis"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD /healthcheck.sh

ENTRYPOINT ["/entrypoint.sh"]
