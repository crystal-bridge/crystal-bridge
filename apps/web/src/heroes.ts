import { useEffect, useState } from 'react';
import type { SessionSummary } from './components/SessionList.js';

/**
 * Heroes (docs/THEME.md): every agent in a Quest is drawn as a Hero of a Class, matched from its name. Everything
 * about the Classes is data in the art pack's `manifest.json` (built by tools/sprites/build_pack.py), so a fork can
 * swap the art and the matching rules without code changes.
 */
export interface HeroAnimFrames {
  frames: number;
  /** Frame size in pixels: 64, or 128 for oversize attacks drawn around a 64px body. */
  size: number;
}

export interface HeroClass {
  name: string;
  /** Lower-case substrings of an agent's name that pick this Class; the first Class that matches wins. */
  match: string[];
  /** The animation that plays while the Hero works, e.g. spellcast, slash, thrust, shoot. */
  work: string;
  /** The Class's word for working, e.g. Heal or Sneak. */
  verb: string;
  /** `emote` (a cheer), or `spellcast` for looks whose outfit has no cheer: a raised cast is held instead. */
  victory: string;
  anims: Record<string, HeroAnimFrames>;
}

export interface HeroManifest {
  /** The Class of a Quest's main agent. */
  leader: string;
  /** The Class of any agent no keyword matches. */
  fallback: string;
  classes: Record<string, HeroClass>;
}

export type HeroState = 'resting' | 'working' | 'alert' | 'victory' | 'ko';

/** The Class id for an agent: the leader's for the main agent, else the first keyword match, else the fallback. */
export function matchClass(manifest: HeroManifest, agent: string | undefined, { leader = false } = {}): string {
  if (leader) return manifest.leader;
  const name = agent?.toLowerCase() ?? '';
  if (name) {
    for (const [id, cls] of Object.entries(manifest.classes)) {
      if (cls.match.some((keyword) => name.includes(keyword.toLowerCase()))) return id;
    }
  }
  return manifest.fallback;
}

/** How long a finished turn's Victory shows before the Hero rests. */
export const VICTORY_MS = 2 * 60_000;
/** A running process quiet this long is resting between turns, not working. */
export const QUIET_MS = 2 * 60_000;

/** The latest attention the hub reported for a Quest: a finished turn or a failure. */
export interface QuestOutcome {
  reason: 'done' | 'failed';
  at: number;
}

/**
 * A Quest's party leader state, from what the client knows without its events: status, whether it waits on the user,
 * its latest activity, and its latest outcome. Needs-you wins; a failure is KO until new activity; a finished turn
 * cheers for a while; a running process with recent activity is working.
 */
export function questState({
  status,
  waiting,
  lastActivity,
  outcome,
  now,
}: {
  status: SessionSummary['status'];
  waiting: boolean;
  lastActivity: number;
  outcome?: QuestOutcome;
  now: number;
}): HeroState {
  if (waiting) return 'alert';
  const fresh = outcome && outcome.at >= lastActivity - 1_000;
  if (outcome?.reason === 'failed' && fresh) return 'ko';
  if (outcome?.reason === 'done' && fresh && now - outcome.at < VICTORY_MS) return 'victory';
  if (status === 'running' && !fresh && now - lastActivity < QUIET_MS) return 'working';
  return 'resting';
}

/** How a state plays: which strip, how fast, whether it loops or holds a frame, and any overlay. */
export interface HeroAnimation {
  anim: string;
  ms: number;
  loop: boolean;
  /** Stop on this frame (a raised cast for Victory without a cheer). */
  hold?: number;
  bubble?: boolean;
  sparkle?: boolean;
}

export function heroAnimation(cls: HeroClass, state: HeroState): HeroAnimation {
  switch (state) {
    case 'working':
      return { anim: cls.work, ms: cls.work === 'shoot' ? 80 : 110, loop: true };
    case 'alert':
      return { anim: 'idle', ms: 520, loop: true, bubble: true };
    case 'victory':
      return cls.victory === 'emote'
        ? { anim: 'emote', ms: 160, loop: false }
        : { anim: cls.victory, ms: 110, loop: false, hold: 3, sparkle: true };
    case 'ko':
      return { anim: 'hurt', ms: 120, loop: false };
    default:
      return { anim: 'idle', ms: 520, loop: true };
  }
}

const MANIFEST_URL = '/heroes/manifest.json';
let manifestPromise: Promise<HeroManifest | null> | undefined;

/** Loads the art pack's manifest once; null when there's no pack (a fork without art, or a failed load). */
export function loadHeroManifest(fetchFn: typeof fetch = fetch): Promise<HeroManifest | null> {
  manifestPromise ??= fetchFn(MANIFEST_URL)
    .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
    .then((data) => {
      const ok =
        typeof data === 'object' && data !== null && 'classes' in data && 'leader' in data && 'fallback' in data;
      if (!ok) manifestPromise = undefined; // try again next time rather than remember a failure
      return ok ? (data as HeroManifest) : null;
    })
    .catch(() => {
      manifestPromise = undefined;
      return null;
    });
  return manifestPromise;
}

/** The art pack's manifest, or null until it has loaded (and for good if there's none). */
export function useHeroManifest(enabled: boolean): HeroManifest | null {
  const [manifest, setManifest] = useState<HeroManifest | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadHeroManifest().then((loaded) => {
      if (live) setManifest(loaded);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return enabled ? manifest : null;
}
