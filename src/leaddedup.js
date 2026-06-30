'use strict';

/**
 * leaddedup.js — plumbing-layer de-duplication for lead notifications.
 *
 * The brain (brain.js) emits a semantic lead on EVERY turn once it has enough to
 * act on, so a single conversation yields many near-identical leads. This helper
 * decides, per conversation, whether a lead is new/changed enough to actually
 * send — so staff get AT MOST ONE notification per session, plus a follow-up only
 * when the meaningful content materially changes. It sends nothing itself: callers
 * pass the returned (merged, most-complete) lead to notify.sendLead().
 *
 * "Meaningful" = part + car + contact, normalized (lowercased, trimmed, whitespace
 * collapsed). The free-text `note` is ignored — it rewords every turn and must not
 * count as a change. Fields ACCUMULATE across turns: a known value is kept even if
 * a later lead omits it, and a newer non-null value replaces it. So filling a blank
 * (car/trim resolved, contact added) or switching part/car is one meaningful update,
 * while re-wording or a dropped field causes no spam.
 */

/** Normalize a field for signature comparison: string, lowercased, ws-collapsed. */
function norm(v) {
  if (v == null) return '';
  return String(v).toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Signature from the meaningful fields only (part + car + contact); note excluded. */
function leadSignature(lead) {
  return [norm(lead.part), norm(lead.car), norm(lead.contact)].join('|');
}

/** Prefer a newer non-null/non-blank value; otherwise keep the previous one. */
function mergeField(prevVal, nextVal) {
  if (nextVal != null && String(nextVal).trim() !== '') return nextVal;
  return prevVal != null ? prevVal : null;
}

/** Merge a new lead onto the accumulated one: fill blanks, replace with newer values. */
function mergeLead(prev, next) {
  const p = prev || {};
  return {
    part: mergeField(p.part, next.part),
    car: mergeField(p.car, next.car),
    customer_name: mergeField(p.customer_name, next.customer_name),
    contact: mergeField(p.contact, next.contact),
    note: mergeField(p.note, next.note),
  };
}

/**
 * Create a per-conversation lead de-duplicator. State is in memory (resets on
 * redeploy), keyed by conversation id (e.g. a Messenger PSID).
 */
function createLeadTracker() {
  const lastByKey = new Map(); // key -> { lead: <merged>, signature }

  return {
    /**
     * Register the lead the brain produced for `key`. Returns the merged,
     * most-complete lead to send, or null if it's a duplicate (nothing material
     * changed since the last lead actually sent for this conversation).
     */
    register(key, lead) {
      if (!lead) return null;
      const prev = lastByKey.get(key);
      const merged = mergeLead(prev && prev.lead, lead);
      const signature = leadSignature(merged);
      if (prev && signature === prev.signature) return null; // duplicate — suppress
      lastByKey.set(key, { lead: merged, signature });
      return merged;
    },
  };
}

module.exports = { createLeadTracker, leadSignature, mergeLead };
