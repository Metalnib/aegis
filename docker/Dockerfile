# ── Stage 1: build Synopsis binary ──────────────────────────────────────────
# Multi-arch: pick the .NET RID matching the target platform. PublishSingleFile
# produces a single executable instead of a directory tree, which keeps the
# COPY into stage 4 simple.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS synopsis-build
ARG TARGETARCH
WORKDIR /src
COPY --from=build-context dotnet-episteme-skills/src/synopsis ./synopsis
RUN case "$TARGETARCH" in \
      amd64) RID=linux-x64 ;; \
      arm64) RID=linux-arm64 ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" && exit 1 ;; \
    esac && \
    dotnet publish synopsis/Synopsis/Synopsis.csproj \
      -c Release -r "$RID" --self-contained true \
      -p:PublishSingleFile=true \
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
COPY packages/adapter-cli/package.json    ./packages/adapter-cli/
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
# libicu* required by .NET for globalization. The synopsis binary is
# self-contained for the .NET runtime, but MSBuild (used to evaluate
# .csproj files) loads the .NET SDK at runtime and needs DOTNET_ROOT
# to point at a valid install. We copy the SDK from stage 1 below.
RUN npm install -g pnpm && apt-get update && apt-get install -y --no-install-recommends git ca-certificates libicu72 && rm -rf /var/lib/apt/lists/*

# Bring the .NET SDK from the build stage so MSBuildLocator can find SDK
# targets when Synopsis evaluates .csproj files. This is the price of a
# graph that resolves real project references; the alternative is asking
# operators to install dotnet themselves on the host. Image size hit ~750MB.
COPY --from=synopsis-build /usr/share/dotnet /usr/share/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet \
    PATH=/usr/share/dotnet:$PATH

WORKDIR /aegis
COPY --from=ts-build /aegis/package.json ./
COPY --from=ts-build /aegis/pnpm-workspace.yaml ./
COPY --from=ts-build /aegis/pnpm-lock.yaml ./
COPY --from=ts-build /aegis/packages/sdk/package.json            ./packages/sdk/
COPY --from=ts-build /aegis/packages/core/package.json           ./packages/core/
COPY --from=ts-build /aegis/packages/agent/package.json          ./packages/agent/
COPY --from=ts-build /aegis/packages/adapter-github/package.json ./packages/adapter-github/
COPY --from=ts-build /aegis/packages/adapter-gitlab/package.json ./packages/adapter-gitlab/
COPY --from=ts-build /aegis/packages/adapter-slack/package.json  ./packages/adapter-slack/
COPY --from=ts-build /aegis/packages/adapter-gchat/package.json  ./packages/adapter-gchat/
COPY --from=ts-build /aegis/packages/adapter-cli/package.json    ./packages/adapter-cli/
COPY --from=ts-build /aegis/packages/cli/package.json            ./packages/cli/
COPY --from=ts-build /aegis/packages/sdk/dist            ./packages/sdk/dist/
COPY --from=ts-build /aegis/packages/core/dist           ./packages/core/dist/
COPY --from=ts-build /aegis/packages/agent/dist          ./packages/agent/dist/
COPY --from=ts-build /aegis/packages/adapter-github/dist ./packages/adapter-github/dist/
COPY --from=ts-build /aegis/packages/adapter-gitlab/dist ./packages/adapter-gitlab/dist/
COPY --from=ts-build /aegis/packages/adapter-slack/dist  ./packages/adapter-slack/dist/
COPY --from=ts-build /aegis/packages/adapter-gchat/dist  ./packages/adapter-gchat/dist/
COPY --from=ts-build /aegis/packages/adapter-cli/dist    ./packages/adapter-cli/dist/
COPY --from=ts-build /aegis/packages/cli/dist            ./packages/cli/dist/

RUN pnpm install --prod --frozen-lockfile

# pnpm workspaces create @aegis/* symlinks inside each package that depends
# on them, but not at the workspace root. The user-mounted aegis.config.ts
# does `require("@aegis/adapter-github")` from /aegis/aegis.config.js, so
# Node needs to find the @aegis namespace at /aegis/node_modules/@aegis/.
# Adapters are NOT direct deps of any workspace package - the user's config
# is the only thing that imports them - so we link every workspace package
# explicitly.
RUN mkdir -p /aegis/node_modules/@aegis && \
    for p in sdk core agent adapter-github adapter-gitlab adapter-slack adapter-gchat adapter-cli cli; do \
      ln -s /aegis/packages/$p /aegis/node_modules/@aegis/$p; \
    done

COPY --from=synopsis-build /out/synopsis/synopsis /opt/aegis/bin/synopsis
# BuildHost-netcore is the child process .NET MSBuild spawns to evaluate
# .csproj files. Single-file publish leaves it as a sibling directory next
# to the binary; without it, Roslyn loads zero projects (filesystem
# discovery still works, semantic analysis does not).
COPY --from=synopsis-build /out/synopsis/BuildHost-netcore /opt/aegis/bin/BuildHost-netcore
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
