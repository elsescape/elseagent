# syntax=docker/dockerfile:1.7
#
# elseagent images. The container is the agent's sandbox: Codex runs commands in it with
# full access (ELSEAGENT_SANDBOX_MODE=danger-full-access, set below).
#
#   docker build --target base -t elseagent:base .   # CLI tools: code, git/GitHub, cloud, media
#   docker build --target full -t elseagent:full .   # base + Chromium, office, fonts, documents
#
# Numbers in the section titles refer to what the agent must be able to do:
#   1 GitHub   2 write code & manage deps   3 cloud CLIs   4 images   5 YouTube/Bilibili video
#   6 office files, websites, marketing material, Excel reports   7 install anything else itself
#   8 databases and data files

ARG DEBIAN_VERSION=trixie

# ============================================================================================
# build: compile elseagent into a single executable
# ============================================================================================
FROM oven/bun:1.4.4 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ============================================================================================
# base: command-line environment
# ============================================================================================
FROM debian:${DEBIAN_VERSION}-slim AS base

ARG TARGETARCH
ARG NODE_VERSION=26.13.1 \
    GO_VERSION=1.27.4 \
    BUN_VERSION=1.4.4 \
    UV_VERSION=0.13.8 \
    KUBECTL_VERSION=1.37.2 \
    HELM_VERSION=4.3.2 \
    GH_VERSION=2.104.0 \
    CLOUDFLARED_VERSION=2026.11.0 \
    YQ_VERSION=4.54.3 \
    WRANGLER_VERSION=4.162.0 \
    AST_GREP_VERSION=0.51.2 \
    SOPS_VERSION=3.13.3 \
    CRANE_VERSION=0.22.1 \
    DUCKDB_VERSION=2.0.0 \
    CODEX_VERSION=0.169.0

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Singapore

# --- OS basics (all) ----------------------------------------------------------------------
# Everyday shell tools: downloads (curl, wget, aria2 for big/parallel downloads), search
# (ripgrep, fd), JSON/YAML (jq, yq), archives incl. making zips for websites (6), scripting
# helpers (bc, envsubst, shellcheck), tmux for long-running processes, debugging (lsof,
# strace), network checks (dig, nc, ping, ip/ss), and sudo so the agent can apt-install more (7).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget aria2 gnupg sudo tzdata locales \
      bash-completion less nano vim-tiny procps psmisc htop tree file tmux \
      jq ripgrep fd-find rsync patch bc gettext-base shellcheck \
      zip unzip xz-utils bzip2 zstd p7zip-full \
      openssh-client dnsutils iputils-ping netcat-openbsd iproute2 lsof strace \
      sqlite3 \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && curl -fsSL -o /usr/local/bin/yq \
      "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${TARGETARCH}" \
    && chmod +x /usr/local/bin/yq \
    && rm -rf /var/lib/apt/lists/*

# --- 1. Git & GitHub ------------------------------------------------------------------------
# git + LFS, and the GitHub CLI. With GH_TOKEN in the environment, both `gh` and plain
# `git clone/push https://github.com/...` are authenticated (gh is git's credential helper).
RUN apt-get update && apt-get install -y --no-install-recommends git git-lfs \
    && curl -fsSL -o /tmp/gh.deb \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.deb" \
    && apt-get install -y /tmp/gh.deb && rm /tmp/gh.deb \
    && git lfs install --system \
    && git config --system credential.https://github.com.helper '!gh auth git-credential' \
    && git config --system init.defaultBranch main \
    && git config --system safe.directory '*' \
    && rm -rf /var/lib/apt/lists/*

# --- 2. C / C++ ----------------------------------------------------------------------------
# GCC/G++, CMake + Ninja, debugger, autotools, and the common -dev headers that native
# packages (Python wheels, Node addons, Go cgo) need when they build from source. (clang is
# left out to save ~400 MB; `sudo apt-get install clang` when needed.)
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential gdb cmake ninja-build pkg-config autoconf automake libtool \
      libssl-dev zlib1g-dev libffi-dev libsqlite3-dev libbz2-dev liblzma-dev \
      libreadline-dev libncurses-dev \
    && rm -rf /var/lib/apt/lists/*

# --- 2. Python + uv -----------------------------------------------------------------------
# System Python, and uv for projects, virtualenvs and other Python versions (`uv python
# install`). /opt/tools is a shared venv on PATH holding the agent's ready-made libraries
# (HTTP, HTML/YAML parsing, numpy + pandas for data; Pillow is added with the image tools),
# so `python script.py` works for quick scripts; the agent can `uv pip install` into it.
COPY --from=ghcr.io/astral-sh/uv:0.13.8 /uv /uvx /usr/local/bin/
ENV UV_LINK_MODE=copy \
    PATH=/opt/tools/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-dev python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && uv venv /opt/tools --python /usr/bin/python3 \
    && uv pip install --python /opt/tools --no-cache \
      requests httpx beautifulsoup4 lxml pyyaml rich numpy pandas

# --- 2. Go ---------------------------------------------------------------------------------
ENV PATH=/usr/local/go/bin:$PATH
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local

# --- 2. Node.js (+ pnpm/yarn via corepack; no longer bundled since Node 25) and Bun ----------
# pnpm/yarn are fetched on first use, at the version a project pins, without asking.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN case "$TARGETARCH" in amd64) NODE_ARCH=x64 BUN_ARCH=x64 ;; arm64) NODE_ARCH=arm64 BUN_ARCH=aarch64 ;; esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE \
    && npm install -g --no-fund --no-audit corepack && corepack enable && npm cache clean --force \
    && curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" \
    && unzip -q -j /tmp/bun.zip -d /usr/local/bin && rm /tmp/bun.zip \
    && ln -s /usr/local/bin/bun /usr/local/bin/bunx

# --- 2. Structural code search: ast-grep --------------------------------------------------
# ast-grep: search and rewrite code by syntax tree, more reliable than regex for large refactors.
RUN case "$TARGETARCH" in amd64) SG_ARCH=x86_64 ;; arm64) SG_ARCH=aarch64 ;; esac \
    && curl -fsSL -o /tmp/sg.zip \
      "https://github.com/ast-grep/ast-grep/releases/download/${AST_GREP_VERSION}/app-${SG_ARCH}-unknown-linux-gnu.zip" \
    && unzip -q /tmp/sg.zip ast-grep -d /usr/local/bin && rm /tmp/sg.zip

# --- 3. Cloud: Kubernetes and Cloudflare --------------------------------------------------
# kubectl (+ kustomize built in) and Helm; Cloudflare's wrangler (Workers, Pages, R2, DNS…)
# and cloudflared (tunnels, Access). Credentials come from the environment or mounted files
# (KUBECONFIG, CLOUDFLARE_API_TOKEN).
RUN curl -fsSL -o /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
    && chmod +x /usr/local/bin/kubectl \
    && curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=1 "linux-${TARGETARCH}/helm" \
    && curl -fsSL -o /tmp/cloudflared.deb \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}.deb" \
    && apt-get update && apt-get install -y /tmp/cloudflared.deb && rm /tmp/cloudflared.deb \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-fund --no-audit "wrangler@${WRANGLER_VERSION}" \
    && npm cache clean --force

# --- 3. Secrets and container images ------------------------------------------------------
# age + sops for encrypted config files (many repositories keep secrets in sops files; keys
# from SOPS_AGE_KEY or SOPS_AGE_KEY_FILE), and crane to inspect and copy images in registries
# (tags, digests, layers) without a Docker daemon.
RUN apt-get update && apt-get install -y --no-install-recommends age \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/sops \
      "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.${TARGETARCH}" \
    && chmod +x /usr/local/bin/sops \
    && case "$TARGETARCH" in amd64) CRANE_ARCH=x86_64 ;; arm64) CRANE_ARCH=arm64 ;; esac \
    && curl -fsSL "https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/go-containerregistry_Linux_${CRANE_ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin crane

# --- 8. Databases and data files ----------------------------------------------------------
# Clients for Postgres (psql), MySQL/MariaDB and Redis, to look into production data;
# DuckDB to query CSV/Parquet/JSON files with SQL; Miller (mlr) for CSV/TSV on the command line.
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql-client mariadb-client redis-tools miller \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb-cli-linux-${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin duckdb

# --- 4. Images -----------------------------------------------------------------------------
# ImageMagick (convert, resize, compose, text), SVG rendering, WebP/PNG/JPEG optimizers,
# EXIF metadata; Pillow for scripted image work.
RUN apt-get update && apt-get install -y --no-install-recommends \
      imagemagick librsvg2-bin webp optipng jpegoptim libimage-exiftool-perl \
    && rm -rf /var/lib/apt/lists/* \
    && uv pip install --python /opt/tools --no-cache pillow

# --- 5. Video: YouTube, Bilibili ----------------------------------------------------------
# yt-dlp downloads video, audio, subtitles and metadata from YouTube, Bilibili and many more;
# ffmpeg merges/converts/cuts. YouTube needs a JavaScript runtime (Node, above) and yt-dlp's
# EJS scripts (the [default] extra). Sites that require login need a cookies file
# (`yt-dlp --cookies cookies.txt`).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && uv pip install --python /opt/tools --no-cache "yt-dlp[default]" \
    && printf -- '--js-runtimes node\n' > /etc/yt-dlp.conf

# --- Agent runtime --------------------------------------------------------------------------
# Codex CLI (which elseagent drives) and elseagent itself. The agent runs as `elseagent` with
# passwordless sudo (7: apt-get install whatever is missing). Everything it keeps lives in its
# home, the one volume: the workspace (~/workspace), Codex sessions (~/.codex), elseagent's
# state (~/.elseagent), and per-user installs (npm -g, go install, bun add -g, uv tools).
RUN npm install -g --no-fund --no-audit "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && useradd --create-home --shell /bin/bash --uid 1000 elseagent \
    && echo 'elseagent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/elseagent \
    && chmod 0440 /etc/sudoers.d/elseagent \
    && chown -R elseagent:elseagent /opt/tools \
    && mkdir -p /etc/elseagent \
    && install -d -o elseagent -g elseagent /home/elseagent/workspace
COPY --from=build /src/dist/elseagent /usr/local/bin/elseagent

ENV NPM_CONFIG_PREFIX=/home/elseagent/.npm-global \
    BUN_INSTALL=/home/elseagent/.bun \
    GOPATH=/home/elseagent/go \
    PATH=/home/elseagent/.local/bin:/home/elseagent/.npm-global/bin:/home/elseagent/.bun/bin:/home/elseagent/go/bin:$PATH
# Codex runs commands in a login shell, and Debian's /etc/profile resets PATH for non-root
# users; restore the full PATH (all the tool directories above) for login shells too.
RUN printf 'export PATH="%s"\n' "$PATH" > /etc/profile.d/00-elseagent-path.sh

USER elseagent
WORKDIR /home/elseagent/workspace
# The container is the sandbox: no Codex sandbox unless the config sets codex.sandboxMode.
ENV HOME=/home/elseagent \
    ELSEAGENT_SANDBOX_MODE=danger-full-access

# The workspace defaults to ~/workspace, so one volume holds everything. Set `workspace` in
# the config to put it elsewhere (e.g. a second volume).
VOLUME ["/home/elseagent"]
ENTRYPOINT ["elseagent"]
CMD ["run", "-c", "/etc/elseagent/config.yaml"]

# ============================================================================================
# full: base + browser, office and document tooling, ClickHouse
# ============================================================================================
FROM base AS full

ARG TARGETARCH
# Python and Node Playwright versions that use the same Chromium build (1255), so one browser
# serves both. Check `browsers.json` in each package when upgrading.
ARG PLAYWRIGHT_PY_VERSION=1.65.2 \
    PLAYWRIGHT_NODE_VERSION=1.65.1 \
    CLICKHOUSE_VERSION=26.10.4.207 \
    CHDB_VERSION=4.4.0
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules

# --- 8. ClickHouse -------------------------------------------------------------------------
# The single `clickhouse` binary (~500 MB, hence `full`): clickhouse-client for servers and
# ClickHouse Cloud, and clickhouse-server for tests. chDB (ClickHouse embedded in Python)
# is installed with the Python libraries below.
RUN curl -fsSL "https://github.com/ClickHouse/ClickHouse/releases/download/v${CLICKHOUSE_VERSION}-stable/clickhouse-common-static-${CLICKHOUSE_VERSION}-${TARGETARCH}.tgz" \
      | tar -xz -C /usr/local/bin --strip-components=3 \
        "clickhouse-common-static-${CLICKHOUSE_VERSION}/usr/bin/clickhouse" \
    && for tool in client server; do ln -s clickhouse "/usr/local/bin/clickhouse-$tool"; done

# --- 6. Fonts ------------------------------------------------------------------------------
# Chinese/Japanese/Korean and emoji, plus metric-compatible Office fonts (Arial/Times/
# Calibri substitutes), so screenshots, PDFs and Office files render text correctly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      fontconfig fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

# --- 6. Office & documents: system tools -----------------------------------------------------
# LibreOffice (headless) converts and recalculates docx/xlsx/pptx and exports PDF; pandoc
# converts between Markdown, HTML, docx and more; PDF tools for merging, splitting, text;
# Pango for weasyprint (HTML+CSS -> PDF). pptxgenjs/docx build PowerPoint/Word from Node.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-java-common- \
      pandoc poppler-utils qpdf ghostscript \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --prefix /usr/local --no-fund --no-audit pptxgenjs docx \
    && npm cache clean --force

# --- 5/6. Browser: system libraries and Node Playwright ---------------------------------------
# Headless Chromium for browsing and scraping pages, screenshots of designs, HTML -> PDF/PNG
# for marketing material, and testing websites, from Python or Node. This installs the
# libraries Chromium needs; the browser itself is installed below, as the agent.
RUN npm install -g --prefix /usr/local --no-fund --no-audit "playwright@${PLAYWRIGHT_NODE_VERSION}" \
    && npm cache clean --force \
    && /usr/local/bin/playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/ms-playwright && chown elseagent:elseagent /opt/ms-playwright

# Installed as the agent, which owns /opt/tools and /opt/ms-playwright: no copies of whole
# directories just to change their owner.
USER elseagent

# --- 5/6. Browser: Chromium (headless shell only; no GUI in a server) --------------------------
# --- 6. Office & documents: Python libraries -------------------------------------------------
# Word, PowerPoint, Excel reports with formulas and charts (openpyxl/xlsxwriter + pandas),
# charts (matplotlib), PDFs (reportlab; weasyprint for HTML+CSS), PDF reading (pypdf,
# pdfplumber), templating (jinja2, markdown), QR codes.
RUN uv pip install --python /opt/tools --no-cache \
      "playwright==${PLAYWRIGHT_PY_VERSION}" \
      python-docx python-pptx openpyxl xlsxwriter matplotlib "chdb==${CHDB_VERSION}" \
      reportlab weasyprint pypdf pdfplumber markdown jinja2 qrcode \
    && playwright install --only-shell chromium
