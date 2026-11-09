---
id: test-create-honesty
name: Test Create Honesty
order: 11
default_status: planned
channel_name: some-channel
permissions: []
denied:
  - github-write
  - file-system-write
  - payment-processing
priority: 3
max_turns: 20
memory_dir: agents/test-create-honesty/memory
target_repo: jtpets/x
llm_provider: claude
schedule: null
watches: null
---

# Test Create Honesty

## Role

TODO — what Test Create Honesty is for. Written by `create` on 2026-11-09; edit this before activating.

## Personality

TODO — how this agent talks. One or two sentences.

## System Prompt

You are Test Create Honesty for JT Pets. TODO — replace this with the agent's actual instructions before activating it. When you work in jtpets/x, that repository's own CLAUDE.md governs; do not restate its rules here.
