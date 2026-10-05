'use strict';

// LOGIC CHANGE 2026-03-26: New tiered memory system with context, working, short-term,
// long-term, and archive files per agent. Provides TTL-based expiry, auto-promotion
// based on access patterns, and cleanup/archival of decayed items.
//
// LOGIC CHANGE 2026-10-05 (WORK-TODO #10): this file is now the facade over three
// modules split on the boundary #10 names: lib/memory-tiers-store.js (constants, entry
// shape, file I/O, expiry/decay predicates), lib/memory-tiers-entries.js (per-tier reads
// and writes), lib/memory-tiers-maintenance.js (cleanup, auto-promotion, startup sweep,
// legacy migration). Every name it exported before is exported here, unchanged.

module.exports = {
    ...require('./memory-tiers-store'),
    ...require('./memory-tiers-entries'),
    ...require('./memory-tiers-maintenance'),
};
