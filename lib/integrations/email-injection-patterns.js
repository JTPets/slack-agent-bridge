/**
 * lib/integrations/email-injection-patterns.js
 *
 * WHAT counts as a prompt-injection attempt in email text: the pattern list and the
 * check that runs it. Moved unchanged out of lib/integrations/email-sanitizer.js
 * (WORK-TODO #10, B28, 2026-11-12), which re-exports both names as the same objects.
 */

'use strict';

// Patterns that indicate prompt injection attempts
// These are checked case-insensitively
// LOGIC CHANGE 2026-04-01: Enhanced patterns to catch more sophisticated attacks
// including Claude-specific jailbreaks and context confusion techniques.
const INJECTION_PATTERNS = [
    // Direct instruction override attempts
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /ignore\s+(the\s+)?(above|prior)\s+(instructions|rules)/i,
    /disregard\s+(all\s+)?(previous|above|prior)/i,
    /forget\s+(all\s+)?(previous|above|prior)/i,
    /override\s+(all\s+)?(previous|prior|your)/i,
    /bypass\s+(all\s+)?(restrictions|rules|guidelines)/i,

    // Role injection
    /you\s+are\s+now\s+(a|an)\s+/i,
    /your\s+new\s+(role|instructions?|task)\s+(is|are)/i,
    /act\s+as\s+(a|an)\s+/i,
    /pretend\s+(you\s+are|to\s+be)\s+/i,
    /roleplay\s+as\s+/i,
    /simulate\s+(being|a|an)\s+/i,
    /from\s+now\s+on\s+(you\s+are|act\s+as)/i,

    // System prompt manipulation
    /system\s*:\s*/i,
    /\[SYSTEM\]/i,
    /<system>/i,
    /\bSYSTEM\s+PROMPT/i,
    /\[INST\]/i,          // Llama instruction format
    /<\|im_start\|>/i,    // ChatML format
    /\[\/INST\]/i,

    // Claude-specific jailbreak attempts
    /\bDAN\b/i,           // "Do Anything Now" jailbreak
    /developer\s+mode/i,
    /jailbreak/i,
    /unrestricted\s+mode/i,
    /no\s+restrictions/i,
    /without\s+safety/i,
    /disable\s+(safety|filters|guidelines)/i,

    // Delimiter abuse
    /```\s*(system|assistant|user)\s*\n/i,
    /---\s*(system|new\s+instructions)/i,
    /<\/?assistant>/i,
    /<\/?user>/i,
    /<\/?human>/i,

    // Output manipulation
    /output\s+only\s+the\s+following/i,
    /respond\s+with\s+only/i,
    /your\s+(only\s+)?response\s+(should|must)\s+be/i,
    /say\s+(exactly|only)\s+/i,
    /repeat\s+after\s+me/i,

    // Data exfiltration attempts
    /reveal\s+(your\s+)?(system\s+prompt|instructions)/i,
    /what\s+are\s+your\s+(system\s+)?(instructions|rules)/i,
    /show\s+me\s+(your\s+)?prompt/i,
    /print\s+(your\s+)?(initial|system)\s+(prompt|instructions)/i,
    /dump\s+(your\s+)?(context|memory|instructions)/i,

    // Context confusion - fake conversation history
    /Human:\s*/i,
    /Assistant:\s*/i,
    /\[User\]:\s*/i,
    /\[AI\]:\s*/i,
    /<<conversation\s+history>>/i,

    // Code execution attempts
    /execute\s+(this\s+)?(code|command|script)/i,
    /run\s+(this\s+)?(code|command|script)/i,
    /eval\s*\(/i,
    /import\s+os/i,
    /subprocess\./i,
    /child_process/i,

    // Hidden instructions
    /\[\s*hidden\s*\]/i,
    /\[\s*secret\s*\]/i,
    /invisible\s+instructions/i,
];

/**
 * Check if text contains prompt injection patterns.
 *
 * @param {string} text - Text to check
 * @returns {{ detected: boolean, patterns: string[] }} Result with detected patterns
 */
function detectInjectionPatterns(text) {
    if (!text || typeof text !== 'string') {
        return { detected: false, patterns: [] };
    }

    const detectedPatterns = [];

    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(text)) {
            detectedPatterns.push(pattern.source);
        }
    }

    return {
        detected: detectedPatterns.length > 0,
        patterns: detectedPatterns,
    };
}
module.exports = { INJECTION_PATTERNS, detectInjectionPatterns };
