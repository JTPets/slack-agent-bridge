# Dockerfile — the jt-agent image, built rather than pulled. PROPOSED (WORK-TODO #70, B6,
# 2026-10-04): the live deployment still runs `image: node:20` until the owner switches
# the compose file to `build:` (docker-compose.example.yml, the PROPOSED BUILD block).
#
# WHY A BUILD STEP. Until this file, the only install step was the compose `command:`,
# run at every container START as an unprivileged user: the toolchain was whatever
# resolved at the last restart (`node:20` floats, `npm install -g @anthropic-ai/claude-code`
# named no version), every deploy paid a full install, and nothing needing root (a system
# package) had anywhere to go. Here the base and the CLI are PINNED, and root work happens
# once, at build.
#
# WHAT IS NOT IN THE IMAGE, deliberately. No source and no secret: the bridge's code is the
# bind-mounted checkout at /bridge (deploys stay `git pull` + restart) and its credentials
# stay in the off-repo env_file. Nothing is COPYed, and .dockerignore excludes the whole
# context so `.env` and `.deploy_key` are never even sent to the build. This image must
# never be shared with the SqTools gate runner, which holds no credential by design (#70).
#
# PINS, and what moves them. Change a pin here, rebuild, restart; the boot post names the
# commit, and `claude --version` in the container names the CLI.
#   node:20.20.2-bookworm  Node 20's last release (2026-03-24, nodejs.org/dist/index.json).
#                          Node 20 reached END OF LIFE in April 2026 - it receives no
#                          security fixes. Moving to 22 is a separate, owner-approved
#                          change. bookworm = Debian 12, matching the 2026-09-20 probe of
#                          the live image. Tag not checked against Docker Hub from here
#                          (the registry was unreachable); `docker compose build` says so
#                          if it is wrong.
#   claude-code 2.1.289    `npm view @anthropic-ai/claude-code version` on 2026-10-04.
#   python3-venv           Debian bookworm's package (security updates only). Supplies
#                          ensurepip, so lib/python-venv.js can create a per-clone venv
#                          with pip in it (#68). It makes python INSTALLABLE; python stays
#                          NOT SUPPORTED in CLAUDE.md's toolchain table until a python repo
#                          has been dispatched to end to end and its pins are named.

FROM node:20.20.2-bookworm

ARG CLAUDE_CODE_VERSION=2.1.289

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv \
 && rm -rf /var/lib/apt/lists/*

# Global install as root at build time: lands in /usr/local/bin/claude, which is the
# CLAUDE_BIN default (lib/config.js). The compose PATH override that put
# /bridge/.npm-global/bin first must be dropped when this image is adopted, or a stale
# CLI left in the bind mount shadows this one.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && claude --version
