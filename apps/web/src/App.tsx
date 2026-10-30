import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { HubClient, ReplayProgress } from './hub.js';
import {
  type Attachment,
  Effort,
  type Engine,
  type Envelope,
  type ExternalSession,
  type PermissionMode,
  type Project,
} from '@crystal-bridge/protocol';
import {
  type Appearance,
  type KingdomLook,
  cacheAppearance,
  fetchAppearance,
  loadCachedAppearance,
  lookFor,
  saveAppearance,
  promptColourFor,
  tabStyle,
  withPromptColour,
  withLook,
  withTabStyle,
} from './appearance.js';
import { Airship } from './components/Airship.js';
import { Castle } from './components/Castle.js';
import { ConfigMenu } from './components/ConfigMenu.js';
import type { PushState } from './components/DevicePush.js';
import {
  type HeroManifest,
  type HeroState,
  LeaderContext,
  leaderFor,
  type QuestOutcome,
  questState,
  useHeroManifest,
  withLeader,
} from './heroes.js';
import { KingdomBar } from './components/KingdomBar.js';
import { NewSession } from './components/NewSession.js';
import { currentActivity } from './activity.js';
import { formatRoute, parseRoute, type Route } from './route.js';
import { classXp, LevelContext, levelFor, type QuestXp } from './levels.js';
import type { NodeUsageRow } from './components/NodeUsage.js';
import { QuestStrip } from './components/QuestStrip.js';
import type { SearchHit } from './components/SearchResults.js';
import type { SessionSummary } from './components/SessionList.js';
import { FILE_ASIDE, SessionView } from './components/SessionView.js';
import { KingdomIcon } from './components/KingdomIcon.js';
import { Inventory } from './components/Inventory.js';
import { SessionPanel } from './components/SessionPanel.js';
import { FileViewer, type FileViewState } from './components/FileViewer.js';
import { FileOpenContext } from './components/markdown.js';
import { sessionInfo } from './info.js';
import { buildInventory } from './inventory.js';
import { usePanel } from './panels.js';
import { SplitPicker } from './components/SplitPicker.js';
import { type KingdomPrefs, listKingdoms, loadPrefs, notifyLevel, pickActive, savePrefs } from './kingdoms.js';
import { sessionMode } from './model.js';
import { MODES } from './modes.js';
import { isLooking, notificationFor } from './notify.js';
import { disablePush, enablePush, openTarget, prefsForPush, pushSupported, syncPush } from './push.js';
import { applyOrder, moveTo } from './tabOrder.js';
import { loadPutAway, putAway as withPutAway, questTabs, savePutAway } from './quests.js';
import { type ActivityItem, startOfDay, startOfWeek, type TurnStats } from './home.js';
import { BUILD_RELEASE, isOutdated } from './release.js';
import { RemovedKingdom } from './components/RemovedKingdom.js';
import { hint, showHeroes, w } from './theme/words.js';

const REFRESH_MS = 5000;
const HOME_REFRESH_MS = 30_000;

async function getJson<T>(url: string, fallback: T): Promise<T> {
  return (await tryJson<T>(url)) ?? fallback;
}

/** The response, or undefined when the hub didn't answer: callers keep what they had rather than blank the page. */
/** What the hub said went wrong, for a call the user made and should hear about. */
async function refusal(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `The hub answered ${response.status}`);
}

async function createJoinCode(node: string): Promise<{ code: string; expiresAt: number }> {
  const response = await fetch('/api/join-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ node }),
  });
  if (!response.ok) throw await refusal(response);
  return (await response.json()) as { code: string; expiresAt: number };
}

async function removeKingdom(node: string): Promise<void> {
  const response = await fetch(`/api/nodes/${encodeURIComponent(node)}`, { method: 'DELETE' });
  if (!response.ok) throw await refusal(response);
}

async function forgetKingdom(node: string): Promise<void> {
  const response = await fetch(`/api/nodes/${encodeURIComponent(node)}/quests`, { method: 'DELETE' });
  if (!response.ok) throw await refusal(response);
}

async function tryJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url);
    return response.ok ? ((await response.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Sets state only from a real answer. */
function keep<T>(set: (value: T) => void, value: T | undefined): void {
  if (value !== undefined) set(value);
}

export function App({ hub }: { hub: HubClient }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [nodes, setNodes] = useState<string[]>([]);
  const [usage, setUsage] = useState<NodeUsageRow[]>([]);
  const [servedRelease, setServedRelease] = useState<string | undefined>(undefined);
  const [external, setExternal] = useState<{ node: string; sessions: ExternalSession[] }[]>([]);
  const [projectLists, setProjectLists] = useState<{ node: string; projects: Project[] }[]>([]);
  const [latestCli, setLatestCli] = useState<string | undefined>(undefined);
  const [removed, setRemoved] = useState<string | null>(null);
  // Who holds a token; undefined until the hub has said, so a Kingdom never looks removed while the page loads.
  const [enrolled, setEnrolled] = useState<string[] | undefined>(undefined);
  const [engineLists, setEngineLists] = useState<{ node: string; engines: Engine[]; release?: string; cli?: string }[]>(
    [],
  );
  // Where the address says the user was (a reload, or a link on this device); a hidden Kingdom's is ignored.
  const [startRoute] = useState(() => {
    const route = parseRoute(window.location.hash);
    return route && 'node' in route && loadPrefs().hidden.includes(route.node) ? null : route;
  });
  const [selected, setSelected] = useState<string | null>(() =>
    startRoute?.page === 'quest' ? startRoute.session : null,
  );
  // Split View: the Quest in the second pane, any Kingdom's; kept on this device until its pane is closed.
  const [split, setSplitState] = useState<string | null>(() => loadSplit()?.second ?? null);
  const [picking, setPicking] = useState(false);
  const [errors, setErrors] = useState<{ id: number; message: string }[]>([]);
  const [prefs, setPrefs] = useState<KingdomPrefs>(() => {
    const loaded = loadPrefs();
    return startRoute && 'node' in startRoute ? { ...loaded, active: startRoute.node } : loaded;
  });
  // The user's Kingdom appearance, shared by their devices: drawn from the local copy, then the hub's.
  const [appearance, setAppearance] = useState<Appearance>(() => loadCachedAppearance());
  // The prompt colour sits on the root, where it reaches every pane of every Quest.
  useEffect(() => {
    const { background, text } = promptColourFor(appearance);
    document.documentElement.style.setProperty('--prompt-background', background);
    document.documentElement.style.setProperty('--prompt-text', text);
  }, [appearance]);
  // The main view: the Airship (Home), or inside the active Kingdom its Castle, the New Quest form, or a Quest.
  const [page, setPage] = useState<'airship' | 'castle' | 'new'>(() =>
    startRoute?.page === 'airship' || startRoute?.page === 'new' ? startRoute.page : 'castle',
  );
  // A folder New Quest starts with, when it was opened from one (the Castle's most-used folders).
  const [newCwd, setNewCwd] = useState<string | undefined>(undefined);
  // Home-page data: finished-turn totals since local midnight and since Monday, and the recent activity log.
  const [statsToday, setStatsToday] = useState<TurnStats[]>([]);
  // Every Quest's lifetime battles, for each Hero Class's level (#23).
  const [questXp, setQuestXp] = useState<QuestXp[]>([]);
  const [statsWeek, setStatsWeek] = useState<TurnStats[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  // Quest tabs put away on this device, per Kingdom.
  const [putAway, setPutAway] = useState(() => loadPutAway());
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  // Sessions waiting on the user (session id -> node), until opened, finished or failed.
  const [waiting, setWaiting] = useState<Record<string, string>>({});
  // Each Quest's latest finished turn or failure, as the hub announced it, for its party leader's pose.
  const [outcomes, setOutcomes] = useState<Record<string, QuestOutcome>>({});
  const heroManifest = useHeroManifest(showHeroes);
  const [canNotify, setCanNotify] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  const [push, setPush] = useState<PushState>(() =>
    !pushSupported() ? 'unsupported' : canNotify === 'denied' ? 'blocked' : 'off',
  );
  const [pushError, setPushError] = useState<string | undefined>(undefined);

  const { visible, hidden } = listKingdoms(nodes, sessions, prefs);
  // Each Kingdom's icon and colour on this device: its own choices, else a look derived from its id.
  const looks: Record<string, KingdomLook> = Object.fromEntries(
    [...visible, ...hidden].map((k) => [k.id, lookFor(appearance, k.id)]),
  );
  const active = pickActive(visible, prefs.active);
  const kingdom = visible.find((k) => k.id === active);

  // Who leads each Quest: its Kingdom's chosen Class, a pick per Quest, or the art pack's leader (#20).
  const leaderOf = useCallback(
    (quest: string) => {
      if (!heroManifest) return undefined;
      const node = sessions.find((s) => s.id === quest)?.node;
      return leaderFor(heroManifest, quest, node ? appearance.looks?.[node]?.leader : undefined);
    },
    [heroManifest, sessions, appearance],
  );
  // Each Class's level: the XP of every Quest it led, by the same leader rule as everywhere else.
  const levels = useMemo(() => {
    if (!heroManifest) return {};
    const xp = classXp(questXp, (quest) => {
      const node = questXp.find((q) => q.session === quest)?.node;
      return leaderFor(heroManifest, quest, node ? appearance.looks?.[node]?.leader : undefined);
    });
    return Object.fromEntries(Object.keys(heroManifest.classes).map((id) => [id, levelFor(xp[id] ?? 0)]));
  }, [heroManifest, questXp, appearance]);
  const questHeroes = (quest: string): HeroManifest | null =>
    heroManifest && withLeader(heroManifest, leaderOf(quest) ?? heroManifest.leader);
  const leaderChoices = heroManifest
    ? [
        heroManifest.leader,
        ...Object.keys(heroManifest.classes)
          .filter((id) => id !== heroManifest.leader)
          .sort((a, b) => heroManifest.classes[a]!.name.localeCompare(heroManifest.classes[b]!.name)),
      ].map((id) => ({ value: id, label: heroManifest.classes[id]!.name }))
    : undefined;
  // Only the active Kingdom's sessions and usage render; others, hidden ones included, show nothing.
  const kingdomSessions = sessions.filter((s) => s.node === active);
  const kingdomUsage = usage.filter((row) => row.node === active);
  const kingdomFound = external.find((row) => row.node === active)?.sessions ?? EMPTY_FOUND;
  const kingdomProjects = projectLists.find((row) => row.node === active)?.projects ?? EMPTY_PROJECTS;
  // A session from another Kingdom (after a switch, or one just hidden) is never shown, nor any on the Airship.
  const shown =
    page === 'airship' || (selected !== null && sessions.some((s) => s.id === selected && s.node !== active))
      ? null
      : selected;

  // The second pane shows only beside an open Quest, and only a Quest this device can see (never a hidden Kingdom's).
  const visibleIds = new Set(visible.map((k) => k.id));
  const splitShown =
    shown && split && split !== shown && sessions.some((s) => s.id === split && visibleIds.has(s.node)) ? split : null;
  function setSplit(session: string | null) {
    setSplitState(session);
    saveSplit(session && shown ? { primary: shown, second: session } : null);
  }
  // Keep the saved pair current as the main pane changes, so a reload reopens what was on screen.
  useEffect(() => {
    if (split && shown && split !== shown) saveSplit({ primary: shown, second: split });
  }, [split, shown]);
  // After a reload, once the Quests are known, reopen a saved split's main Quest (if both still exist and show here).
  const splitRestored = useRef(false);
  useEffect(() => {
    if (splitRestored.current || sessions.length === 0) return;
    splitRestored.current = true;
    const saved = loadSplit();
    if (!saved || selected !== null) return;
    const primary = sessions.find((s) => s.id === saved.primary);
    const second = sessions.find((s) => s.id === saved.second);
    if (!primary || !second || !visibleIds.has(primary.node) || !visibleIds.has(second.node)) return;
    setPrefs((prev) => ({ ...prev, active: primary.node }));
    setPage('castle');
    setSelected(primary.id);
  }, [sessions, selected, visibleIds]);

  const waitingByKingdom: Record<string, number> = {};
  for (const node of Object.values(waiting)) waitingByKingdom[node] = (waitingByKingdom[node] ?? 0) + 1;
  const waitingShown = visible.reduce((total, k) => total + (waitingByKingdom[k.id] ?? 0), 0);
  const waitingIds = new Set(Object.keys(waiting));

  useEffect(() => {
    document.title = waitingShown > 0 ? `(${waitingShown}) Crystal Bridge` : 'Crystal Bridge';
  }, [waitingShown]);

  // Opening a session, in either pane, clears its waiting mark.
  useEffect(() => {
    const open = [shown, splitShown && splitPaneVisible() ? splitShown : null].filter(
      (id): id is string => id !== null,
    );
    if (open.length > 0)
      setWaiting((prev) =>
        open.some((id) => id in prev)
          ? Object.fromEntries(Object.entries(prev).filter(([id]) => !open.includes(id)))
          : prev,
      );
  }, [shown, splitShown]);

  // Another tab changed this device's Kingdom settings: take them, so open tabs never disagree.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === 'crystal-bridge.kingdoms') setPrefs(loadPrefs());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Shows a session a notification pointed at: switch to its Kingdom, unless this device hides it.
  const openSession = useCallback((node: string, session: string) => {
    if (loadPrefs().hidden.includes(node)) return;
    setPrefs((prev) => {
      const next = { ...prev, active: node };
      savePrefs(next);
      return next;
    });
    setPage('castle');
    setSelected(session);
  }, []);

  // The attention listener outlives renders, so it reads current state through a ref.
  const current = useRef({ shown, splitShown });
  current.current = { shown, splitShown };

  useEffect(
    () =>
      hub.onAttention((attention) => {
        // Privacy settings are read fresh from storage, never from what this tab loaded earlier: a Kingdom made
        // Discreet or hidden in another tab must be honoured even if this tab missed the change.
        const p = loadPrefs();
        const { shown: open, splitShown: openBeside } = current.current;
        if (p.hidden.includes(attention.node)) return; // A hidden Kingdom never notifies.
        const looking =
          isLooking(open, attention.session) || (splitPaneVisible() && isLooking(openBeside, attention.session));
        if (attention.reason !== 'needs-you') {
          const reason = attention.reason;
          setOutcomes((prev) => ({ ...prev, [attention.session]: { reason, at: Date.now() } }));
        }
        setWaiting((prev) => {
          const next = { ...prev };
          if (attention.reason === 'needs-you' && !looking) next[attention.session] = attention.node;
          else delete next[attention.session];
          return next;
        });
        if (looking || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const shownText = notificationFor(
          attention,
          p.names[attention.node] || attention.node,
          notifyLevel(p, attention.node),
        );
        if (!shownText) return;
        const notification = new Notification(shownText.title, { body: shownText.body, tag: attention.session });
        notification.onclick = () => {
          window.focus();
          openSession(attention.node, attention.session);
          notification.close();
        };
      }),
    [hub, openSession],
  );

  // A push notification's click opens the app at `?node=&session=`, or messages a window that's already open.
  useEffect(() => {
    const target = openTarget(window.location.search);
    if (!target) return;
    window.history.replaceState(null, '', window.location.pathname);
    openSession(target.node, target.session);
  }, [openSession]);
  useEffect(() => {
    if (!pushSupported()) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { kind?: unknown; node?: unknown; session?: unknown } | null;
      if (data?.kind === 'open' && typeof data.node === 'string' && typeof data.session === 'string')
        openSession(data.node, data.session);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [openSession]);

  // While this device is subscribed, the hub words its pushes from these prefs: resend them whenever they change.
  const pushPrefs = JSON.stringify(prefsForPush(prefs));
  useEffect(() => {
    if (!pushSupported()) return;
    let cancelled = false;
    void navigator.serviceWorker.ready
      .then((registration) => syncPush(registration, JSON.parse(pushPrefs) as KingdomPrefs))
      .then((on) => {
        if (!cancelled) setPush((prev) => (prev === 'busy' || prev === 'blocked' ? prev : on ? 'on' : 'off'));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pushPrefs]);

  async function togglePush(on: boolean) {
    setPush('busy');
    setPushError(undefined);
    try {
      if (on && Notification.permission === 'default') setCanNotify(await Notification.requestPermission());
      const registration = await navigator.serviceWorker.ready;
      if (on) await enablePush(registration, loadPrefs());
      else await disablePush(registration);
      setPush(on ? 'on' : 'off');
    } catch (error) {
      const permission = Notification.permission;
      setCanNotify(permission);
      setPush(permission === 'denied' ? 'blocked' : on ? 'off' : 'on');
      setPushError(error instanceof Error ? error.message : String(error));
    }
  }

  // Search the active Kingdom only, a moment after typing stops.
  const searching = query.trim().length >= 2 && active !== null;
  useEffect(() => {
    if (!searching || !active) return;
    const timer = setTimeout(() => {
      void getJson<SearchHit[]>(
        `/api/search?node=${encodeURIComponent(active)}&q=${encodeURIComponent(query.trim())}`,
        [],
      ).then(setHits);
    }, 250);
    return () => clearTimeout(timer);
  }, [searching, active, query]);

  function updatePrefs(change: (prev: KingdomPrefs) => KingdomPrefs) {
    setPrefs((prev) => {
      const next = change(prev);
      savePrefs(next);
      return next;
    });
  }

  // The Quest each Kingdom last showed, so switching Kingdoms and back returns to it rather than to the Castle.
  const lastQuest = useRef<Record<string, string | null>>({});
  function selectKingdom(id: string) {
    if (active) lastQuest.current[active] = shown;
    updatePrefs((prev) => ({ ...prev, active: id }));
    setPage('castle');
    const back = lastQuest.current[id];
    setSelected(back && sessions.some((s) => s.id === back && s.node === id) ? back : null);
  }

  /** Shows a Quest of the active Kingdom. */
  function openQuest(id: string) {
    setPage('castle');
    setSelected(id);
  }

  /** Takes a Quest's tab away on this device until it has new activity; the Castle shows instead if it was open. */
  function putAwayQuest(id: string) {
    const session = sessions.find((s) => s.id === id);
    if (!session || !active) return;
    const next = withPutAway(putAway, active, id, session.lastActivity ?? session.createdAt);
    setPutAway(next);
    savePutAway(next);
    if (id === shown) setSelected(null);
  }

  const status = useSyncExternalStore(hub.onChange, () => hub.status);
  // The link starts out connecting on every load; only a link that dropped is worth a banner.
  const everOpen = useRef(false);
  if (status === 'open') everOpen.current = true;
  const envelopes = useSyncExternalStore(hub.onChange, () => (shown ? hub.events(shown) : EMPTY));
  // Its own snapshot: the replay's end changes no events, but must still swap the loading screen for the chat.
  const progress = useSyncExternalStore(hub.onChange, () => (shown ? hub.progress(shown) : undefined));
  const splitEnvelopes = useSyncExternalStore(hub.onChange, () => (splitShown ? hub.events(splitShown) : EMPTY));
  const splitProgress = useSyncExternalStore(hub.onChange, () => (splitShown ? hub.progress(splitShown) : undefined));

  // In a split, one Inventory and one side panel serve both panes: they follow the pane last clicked or typed in.
  const [focusedPane, setFocusedPane] = useState<string | null>(null);
  const focused = splitShown && focusedPane === splitShown ? splitShown : shown;
  const focusedEvents = useDeferredValue(focused === splitShown && splitShown ? splitEnvelopes : envelopes);
  const focusedInfo = useMemo(() => sessionInfo(focusedEvents), [focusedEvents]);
  const focusedActivity = useMemo(() => currentActivity(focusedEvents), [focusedEvents]);
  const focusedInventory = useMemo(() => buildInventory(focusedEvents), [focusedEvents]);
  const [detailsOpen] = usePanel('details');
  const [inventoryOpen] = usePanel('inventory');
  // An Inventory pick for the focused pane's follow-up box; `seq` makes picking the same entry twice count.
  const [insertion, setInsertion] = useState<{ session: string; text: string; seq: number } | null>(null);
  function pick(text: string) {
    if (focused) setInsertion((prev) => ({ session: focused, text, seq: (prev?.seq ?? 0) + 1 }));
  }

  // The read-only file viewer: one file at a time, of a Quest on screen; its Kingdom reads it through the hub.
  const [fileView, setFileView] = useState<FileViewState | null>(null);
  // One stable opener per Quest: it's context for every message, and a new function each render would redraw them all.
  const openers = useRef(new Map<string, (path: string) => void>());
  const openFileFor = useCallback(
    (session: string) => {
      let opener = openers.current.get(session);
      if (!opener) {
        opener = (path: string) => {
          setFocusedPane(session);
          setFileView({ session, requested: path });
          void hub
            .readFile(session, path)
            .then((reply) =>
              setFileView((current) =>
                current && current.session === session && current.requested === path ? { ...current, reply } : current,
              ),
            );
        };
        openers.current.set(session, opener);
      }
      return opener;
    },
    [hub],
  );
  const closeFile = useCallback(() => setFileView(null), []);
  const viewing = fileView && (fileView.session === shown || fileView.session === splitShown) ? fileView : null;
  const fileViewer = viewing ? (
    <FileViewer
      key={`${viewing.session}:${viewing.requested}`}
      file={viewing}
      onClose={closeFile}
      onOpen={openFileFor(viewing.session)}
    />
  ) : null;

  const refresh = useCallback(async () => {
    // A hub that's down or restarting fails these; the page keeps its last picture instead of going blank.
    const [s, n, u, x, h, p, e, l, a, t] = await Promise.all([
      tryJson<SessionSummary[]>('/api/sessions'),
      tryJson<string[]>('/api/nodes'),
      tryJson<NodeUsageRow[]>('/api/usage'),
      tryJson<{ node: string; sessions: ExternalSession[] }[]>('/api/external'),
      tryJson<{ release?: string }>('/api/health'),
      tryJson<{ node: string; projects: Project[] }[]>('/api/projects'),
      tryJson<{ node: string; engines: Engine[]; release?: string; cli?: string }[]>('/api/engines'),
      tryJson<{ latest?: string }>('/api/cli-latest'),
      tryJson<{ session: string; node: string }[]>('/api/waiting'),
      tryJson<string[]>('/api/nodes/enrolled'),
    ]);
    keep(setSessions, s);
    keep(setNodes, n);
    if (t) setEnrolled(t);
    keep(setUsage, u);
    keep(setExternal, x);
    if (h) setServedRelease(h.release);
    keep(setProjectLists, p);
    keep(setEngineLists, e);
    if (l) setLatestCli(l.latest);
    // The hub's word, so a reload or a new device knows too. Not for a Quest in view, or on a hidden Kingdom.
    if (a) {
      const hidden = loadPrefs().hidden;
      const { shown: open, splitShown: beside } = current.current;
      setWaiting(
        Object.fromEntries(
          a
            .filter(
              ({ session, node }) => !hidden.includes(node) && !isLooking(open, session) && !isLooking(beside, session),
            )
            .map(({ session, node }) => [session, node]),
        ),
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // The home pages' totals and log change slowly; the boundaries are this device's own midnight and Monday.
  const refreshHome = useCallback(async () => {
    const now = Date.now();
    const [today, week, log, xp] = await Promise.all([
      tryJson<TurnStats[]>(`/api/stats?since=${startOfDay(now)}`),
      tryJson<TurnStats[]>(`/api/stats?since=${startOfWeek(now)}`),
      tryJson<ActivityItem[]>('/api/activity?limit=30'),
      showHeroes ? tryJson<QuestXp[]>('/api/xp') : Promise.resolve(undefined),
    ]);
    keep(setStatsToday, today);
    keep(setStatsWeek, week);
    keep(setActivity, log);
    keep(setQuestXp, xp);
  }, []);
  useEffect(() => {
    void refreshHome();
    const timer = setInterval(() => void refreshHome(), HOME_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshHome]);

  useEffect(
    () => hub.onError((message) => setErrors((prev) => [...prev, { id: Date.now() + Math.random(), message }])),
    [hub],
  );

  // The hub's appearance replaces the local copy once it answers; a change on another device arrives live.
  useEffect(() => {
    let cancelled = false;
    void fetchAppearance().then((fresh) => {
      if (fresh && !cancelled) {
        setAppearance(fresh);
        cacheAppearance(fresh);
      }
    });
    const off = hub.onAppearance((fresh) => {
      setAppearance(fresh);
      cacheAppearance(fresh);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [hub]);

  /** Applies an appearance change here at once and saves it for the user's other devices. */
  function changeAppearance(change: (prev: Appearance) => Appearance) {
    const next = change(appearance);
    setAppearance(next);
    saveAppearance(next).catch((error: unknown) =>
      setErrors((errs) => [
        ...errs,
        {
          id: Date.now() + Math.random(),
          message: `Couldn't save the ${w('kingdom')} look: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]),
    );
  }

  const subscribeErrors = useCallback((listener: (message: string) => void) => hub.onError(listener), [hub]);

  useEffect(() => {
    if (shown) hub.subscribe(shown);
  }, [hub, shown]);
  useEffect(() => {
    if (splitShown) hub.subscribe(splitShown);
  }, [hub, splitShown]);

  function start({
    node,
    cwd,
    prompt,
    mode,
    worktree,
    engine,
    effort,
    attachments,
  }: {
    node: string;
    cwd: string;
    prompt: string;
    mode: PermissionMode;
    worktree: boolean;
    engine?: Engine;
    effort?: Effort;
    attachments?: Attachment[];
  }) {
    const session = crypto.randomUUID();
    hub.subscribe(session);
    hub.send({
      type: 'session.start',
      node,
      session,
      cwd,
      prompt,
      mode,
      ...(worktree ? { worktree } : {}),
      ...(engine ? { engine } : {}),
      ...(effort ? { effort } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });
    openQuest(session);
    // The hub records the session once the node reports `session.started`.
    setTimeout(() => void refresh(), 500);
  }

  /** Forks the shown session; the hub runs the fork on the source's node and in its folder. */
  function fork(prompt: string) {
    const source = sessions.find((s) => s.id === shown);
    if (!source) return;
    const session = crypto.randomUUID();
    // Carry the source's mode over; a mode this client can't pick (unlikely) falls back to the node's default.
    const mode = MODES.find((m) => m.value === sessionMode(envelopes))?.value;
    // And its effort, so the fork thinks as hard as the Quest it came from.
    const effort = Effort.safeParse(sessionInfo(envelopes).effort);
    hub.subscribe(session);
    hub.send({
      type: 'session.start',
      node: source.node,
      session,
      cwd: source.cwd,
      prompt,
      forkFrom: source.id,
      ...(mode ? { mode } : {}),
      ...(effort.success ? { effort: effort.data } : {}),
    });
    openQuest(session);
    setTimeout(() => void refresh(), 500);
  }

  function adopt(session: string, engine?: Engine) {
    if (!active) return;
    hub.subscribe(session);
    hub.send({ type: 'session.adopt', node: active, session, ...(engine ? { engine } : {}) });
    openQuest(session);
    setTimeout(() => void refresh(), 500);
  }

  /** One Quest's view: the main one, or either pane of a split. */
  function questView(id: string, events: Envelope[], loaded: ReplayProgress | undefined, primary: boolean) {
    const node = sessions.find((s) => s.id === id)?.node;
    return (
      <SessionView
        key={id}
        session={id}
        relayedBytes={sessions.find((s) => s.id === id)?.relayedBytes}
        envelopes={events}
        progress={loaded}
        onAnswer={(requestId, behavior, answers) =>
          hub.send({ type: 'permission.answer', session: id, requestId, behavior, ...(answers ? { answers } : {}) })
        }
        onSend={(text, attachments) =>
          hub.send({ type: 'session.send', session: id, text, ...(attachments?.length ? { attachments } : {}) })
        }
        onInterrupt={() => hub.send({ type: 'session.interrupt', session: id })}
        onMode={(mode) => hub.send({ type: 'session.mode', session: id, mode })}
        kingdom={visible.find((k) => k.id === node)?.name ?? node ?? ''}
        party={heroManifest ? { manifest: questHeroes(id)!, leaderState: heroStates[id] ?? 'resting' } : undefined}
        onClose={(removeWorktree) =>
          hub.send({ type: 'session.close', session: id, ...(removeWorktree ? { removeWorktree } : {}) })
        }
        onFork={primary ? fork : undefined}
        onOpen={openQuest}
        labelOf={(other) => sessions.find((s) => s.id === other)?.label}
        subscribeErrors={subscribeErrors}
        compact={splitShown !== null}
        onSplit={primary && splitShown === null ? () => setPicking(true) : undefined}
        onExitSplit={primary && splitShown !== null ? () => setSplit(null) : undefined}
        insertion={insertion?.session === id ? insertion : undefined}
        plan={usage.find((u) => u.node === node)?.windows}
        planAt={usage.find((u) => u.node === node)?.ts}
        onOpenFile={openFileFor(id)}
        fileViewer={primary && splitShown === null ? fileViewer : undefined}
      />
    );
  }

  /**
   * A pane of a split: which Kingdom and Quest it shows, a highlight when the shared panels follow it, and for the
   * second pane, the way back to one Quest. Clicking or typing anywhere in it focuses it.
   */
  function pane(id: string, body: ReactNode, onExitSplit?: () => void) {
    const session = sessions.find((s) => s.id === id);
    const node = session?.node ?? '';
    const look = looks[node];
    const label = session?.label || id;
    const isFocused = focused === id;
    return (
      <section
        aria-label={`${w('quest')}: ${label}`}
        data-focused={isFocused}
        onPointerDownCapture={() => setFocusedPane(id)}
        onFocusCapture={() => setFocusedPane(id)}
        style={look ? ({ '--k': look.colour } as CSSProperties) : undefined}
        className={`cb-pane min-w-0 flex-1 flex-col ${onExitSplit ? 'hidden border-l border-neutral-300 lg:flex dark:border-neutral-700' : 'flex'}`}
      >
        <div className="hidden items-center gap-2 border-b border-neutral-300 bg-neutral-100 px-3 py-1 text-sm lg:flex dark:border-neutral-700 dark:bg-neutral-900">
          {look && <KingdomIcon icon={look.icon} colour={look.colour} size={16} />}
          <span className="text-neutral-500">{visible.find((k) => k.id === node)?.name ?? node}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
          {onExitSplit && (
            <button
              type="button"
              onClick={onExitSplit}
              title={hint('exitSplit')}
              className="flex items-center gap-1 rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-200 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <span aria-hidden>⇤</span>
              {w('exitSplit')}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1">{body}</div>
      </section>
    );
  }

  const tabs = active
    ? applyOrder(
        questTabs(kingdomSessions, { now: Date.now(), shown, waiting: waitingIds, putAway: putAway[active] ?? {} }),
        prefs.questOrder?.[active],
      )
    : [];
  const view = page === 'airship' ? 'airship' : shown ? 'quest' : page;
  // The address follows the view, so a reload comes back here, and each new view is a history entry, so Back (a
  // phone's back gesture too) returns to the one before; the hashchange listener below follows it. The first write
  // after loading replaces, so settling on a view at startup doesn't add a step.
  const addressSet = useRef(false);
  useEffect(() => {
    let route: Route | null = null;
    if (view === 'airship') route = { page: 'airship' };
    else if (active && view === 'quest' && shown) route = { page: 'quest', node: active, session: shown };
    else if (active && view === 'new') route = { page: 'new', node: active };
    else if (active && view === 'castle') route = { page: 'castle', node: active };
    if (!route) return;
    const hash = formatRoute(route);
    if (window.location.hash !== hash) {
      const url = `${window.location.pathname}${window.location.search}${hash}`;
      if (addressSet.current) window.history.pushState(null, '', url);
      else window.history.replaceState(null, '', url);
    }
    addressSet.current = true;
  }, [view, active, shown]);
  // And the view follows the address when something else changes it (a link, an edited address), as on a reload.
  const followRoute = useRef<(route: Route) => void>(() => {});
  followRoute.current = (route) => {
    if (route.page === 'airship') {
      setPage('airship');
      return;
    }
    if (prefs.hidden.includes(route.node)) return;
    updatePrefs((prev) => ({ ...prev, active: route.node }));
    setPage(route.page === 'new' ? 'new' : 'castle');
    setSelected(route.page === 'quest' ? route.session : null);
  };
  useEffect(() => {
    const onHash = () => {
      const route = parseRoute(window.location.hash);
      if (route) followRoute.current(route);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const now = Date.now();
  const heroStates: Record<string, HeroState> = {};
  // Every Quest's, not just this Kingdom's: a split can show another Kingdom's Quest.
  for (const session of sessions) {
    heroStates[session.id] = questState({
      status: session.status,
      waiting: waitingIds.has(session.id),
      lastActivity: session.lastActivity ?? session.createdAt,
      outcome: outcomes[session.id],
      now,
    });
  }

  return (
    <LeaderContext.Provider value={leaderOf}>
      <LevelContext.Provider value={levels}>
        <div className="flex h-dvh flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
          <header className="flex items-end gap-3 border-b border-neutral-300 bg-neutral-200 px-3 pt-2 sm:gap-6 sm:px-4 dark:border-neutral-700 dark:bg-neutral-800">
            <button
              type="button"
              onClick={() => setPage('airship')}
              title={hint('home')}
              className="mb-1.5 flex shrink-0 items-center gap-2 rounded-md px-1 py-1 hover:bg-neutral-300 dark:hover:bg-neutral-700"
            >
              <img src="/favicon.svg" alt="" width={32} height={32} className="[image-rendering:pixelated]" />
              <span className="cb-display hidden text-3xl leading-none sm:inline">Crystal Bridge</span>
              <span className="sr-only sm:hidden">Crystal Bridge</span>
            </button>
            <div className="min-w-0 flex-1 pt-2">
              <KingdomBar
                visible={visible}
                active={page === 'airship' ? null : active}
                onSelect={selectKingdom}
                waiting={waitingByKingdom}
                looks={looks}
                tabStyle={tabStyle(appearance)}
                onMove={(id, index) =>
                  updatePrefs((prev) => ({
                    ...prev,
                    order: moveTo(
                      visible.map((k) => k.id),
                      id,
                      index,
                    ),
                  }))
                }
              />
            </div>
            <div className="mb-1.5">
              <ConfigMenu
                leaders={leaderChoices}
                onCreateJoinCode={createJoinCode}
                visible={visible}
                hidden={hidden}
                onRename={(id, name) =>
                  updatePrefs((prev) => {
                    const names = { ...prev.names };
                    if (name.trim()) names[id] = name;
                    else delete names[id];
                    return { ...prev, names };
                  })
                }
                onToggleHidden={(id) =>
                  updatePrefs((prev) => ({
                    ...prev,
                    hidden: prev.hidden.includes(id) ? prev.hidden.filter((h) => h !== id) : [...prev.hidden, id],
                  }))
                }
                notify={prefs.notify ?? {}}
                onNotify={(id, level) => updatePrefs((prev) => ({ ...prev, notify: { ...prev.notify, [id]: level } }))}
                looks={looks}
                onLook={(id, change) => changeAppearance((prev) => withLook(prev, id, change))}
                tabStyle={tabStyle(appearance)}
                onTabStyle={(style) => changeAppearance((prev) => withTabStyle(prev, style))}
                promptColour={promptColourFor(appearance).id}
                onPromptColour={(id) => changeAppearance((prev) => withPromptColour(prev, id))}
                status={status}
                canNotify={canNotify}
                onEnableNotifications={() => void Notification.requestPermission().then(setCanNotify)}
                push={push}
                pushError={pushError}
                onPush={(on) => void togglePush(on)}
              />
            </div>
          </header>
          {(status === 'closed' || (status === 'connecting' && everOpen.current)) && (
            <div
              role="status"
              className="flex items-center gap-2 bg-amber-100 px-4 py-1.5 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              Lost the connection to the hub. Reconnecting… What you see may be out of date until it's back.
            </div>
          )}
          {isOutdated(BUILD_RELEASE, servedRelease) && (
            <div className="flex items-center gap-3 bg-blue-600 px-4 py-1.5 text-sm text-white">
              <span>Crystal Bridge was updated.</span>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded bg-white/20 px-2 font-medium hover:bg-white/30"
              >
                Reload
              </button>
            </div>
          )}
          {removed && <RemovedKingdom name={removed} onDismiss={() => setRemoved(null)} />}
          {view !== 'airship' && kingdom && (
            <QuestStrip
              castleName={kingdom.name}
              quests={tabs}
              current={shown ?? page}
              waiting={waitingIds}
              heroes={heroManifest ? { manifest: heroManifest, states: heroStates } : undefined}
              onCastle={() => {
                setPage('castle');
                setSelected(null);
              }}
              onSelect={openQuest}
              onPutAway={putAwayQuest}
              onMove={(id, index) =>
                updatePrefs((prev) => ({
                  ...prev,
                  questOrder: {
                    ...prev.questOrder,
                    [kingdom.id]: moveTo(
                      tabs.map((t) => t.id),
                      id,
                      index,
                    ),
                  },
                }))
              }
              onNew={() => {
                setPage('new');
                setSelected(null);
              }}
            />
          )}
          {errors.map((error) => (
            <div
              key={error.id}
              className="flex items-center gap-2 bg-red-100 px-4 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
            >
              <span className="flex-1">{error.message}</span>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setErrors((prev) => prev.filter((e) => e.id !== error.id))}
                className="px-2 font-bold"
              >
                ×
              </button>
            </div>
          ))}
          <main className="min-h-0 flex-1">
            {view === 'airship' ? (
              <Airship
                kingdoms={visible}
                sessions={sessions}
                waiting={waiting}
                usage={usage}
                notify={prefs.notify ?? {}}
                looks={looks}
                onKingdom={selectKingdom}
                onQuest={openSession}
                today={statsToday}
                activity={activity}
                heroes={heroManifest}
                heroStates={heroStates}
                levels={levels}
                onNewQuest={(node) => {
                  selectKingdom(node);
                  setSelected(null);
                  setNewCwd(undefined);
                  setPage('new');
                }}
              />
            ) : !kingdom ? (
              <p className="p-6 text-sm text-neutral-500">
                {hidden.length > 0
                  ? `Every ${w('kingdom')} is hidden on this device. Show one from ${w('config')}.`
                  : `No ${w('kingdoms')} yet.`}
              </p>
            ) : view === 'quest' && shown ? (
              splitShown ? (
                <div className="flex h-full">
                  {inventoryOpen && (
                    // Shared by both panes, so only where three columns fit beside two chats.
                    <aside
                      aria-label={w('inventory')}
                      className="hidden w-60 shrink-0 overflow-y-auto border-r border-neutral-300 p-3 xl:block dark:border-neutral-700"
                    >
                      <Inventory inventory={focusedInventory} onUse={pick} />
                    </aside>
                  )}
                  {pane(shown, questView(shown, envelopes, progress, true))}
                  {pane(splitShown, questView(splitShown, splitEnvelopes, splitProgress, false), () => setSplit(null))}
                  {fileViewer ? (
                    <aside aria-label={w('scroll')} className={FILE_ASIDE}>
                      {fileViewer}
                    </aside>
                  ) : (
                    detailsOpen &&
                    focused && (
                      <aside
                        aria-label="Session details"
                        className="hidden w-80 shrink-0 overflow-y-auto border-l border-neutral-300 p-3 lg:block dark:border-neutral-700"
                      >
                        <FileOpenContext.Provider value={openFileFor(focused)}>
                          <SessionPanel
                            info={focusedInfo}
                            plan={usage.find((u) => u.node === sessions.find((s) => s.id === focused)?.node)?.windows}
                            planAt={usage.find((u) => u.node === sessions.find((s) => s.id === focused)?.node)?.ts}
                            kingdom={(() => {
                              const node = sessions.find((s) => s.id === focused)?.node ?? '';
                              return visible.find((k) => k.id === node)?.name ?? node;
                            })()}
                            party={
                              heroManifest
                                ? { manifest: questHeroes(focused)!, leaderState: heroStates[focused] ?? 'resting' }
                                : undefined
                            }
                            relayedBytes={sessions.find((s) => s.id === focused)?.relayedBytes}
                            activity={focusedActivity}
                          />
                        </FileOpenContext.Provider>
                      </aside>
                    )
                  )}
                </div>
              ) : (
                questView(shown, envelopes, progress, true)
              )
            ) : view === 'new' ? (
              <div className="h-full overflow-y-auto">
                <NewSession
                  key={`${kingdom.id}:${newCwd ?? ''}`}
                  node={kingdom.id}
                  name={kingdom.name}
                  connected={kingdom.connected}
                  projects={kingdomProjects}
                  engines={engineLists.find((row) => row.node === kingdom.id)?.engines}
                  initialCwd={newCwd}
                  onStart={start}
                />
              </div>
            ) : (
              <Castle
                kingdom={kingdom}
                look={looks[kingdom.id]}
                sessions={kingdomSessions}
                waiting={waitingIds}
                usage={kingdomUsage}
                found={kingdomFound}
                engines={engineLists.find((row) => row.node === kingdom.id)?.engines}
                release={engineLists.find((row) => row.node === kingdom.id)?.release}
                hubRelease={servedRelease}
                onRemove={async (id) => {
                  await removeKingdom(id);
                  setRemoved(kingdom.name);
                }}
                removed={!kingdom.connected && enrolled !== undefined && !enrolled.includes(kingdom.id)}
                onForget={async (id) => {
                  await forgetKingdom(id);
                  setRemoved(null);
                  await refresh();
                }}
                cli={engineLists.find((row) => row.node === kingdom.id)?.cli}
                latestCli={latestCli}
                today={statsToday.find((row) => row.node === kingdom.id) ?? null}
                week={statsWeek.find((row) => row.node === kingdom.id) ?? null}
                heroes={heroManifest}
                heroStates={heroStates}
                onNewIn={(cwd) => {
                  setNewCwd(cwd);
                  setPage('new');
                }}
                onAdopt={adopt}
                onSelect={openQuest}
                onNew={() => {
                  setNewCwd(undefined);
                  setPage('new');
                }}
                query={query}
                onQuery={setQuery}
                hits={searching ? hits : []}
                onOpenHit={(id) => {
                  openQuest(id);
                  setQuery('');
                }}
              />
            )}
          </main>
          {picking && shown && (
            <SplitPicker
              candidates={sessions
                .filter((s) => s.status !== 'closed' && s.id !== shown && visibleIds.has(s.node))
                .sort((a, b) => (b.lastActivity ?? b.createdAt) - (a.lastActivity ?? a.createdAt))
                .map((s) => ({
                  id: s.id,
                  label: s.label || s.id,
                  kingdom: visible.find((k) => k.id === s.node)?.name ?? s.node,
                  look: looks[s.node] ?? lookFor(appearance, s.node),
                  state: heroStates[s.id],
                }))}
              heroes={heroManifest ?? undefined}
              onPick={(session) => {
                hub.subscribe(session);
                setSplit(session);
                setPicking(false);
              }}
              onCancel={() => setPicking(false)}
            />
          )}
        </div>
      </LevelContext.Provider>
    </LeaderContext.Provider>
  );
}

const EMPTY: never[] = [];

const SPLIT_KEY = 'crystal-bridge.split';

/** The second pane only shows on wide screens (Tailwind's lg); on a phone its Quest isn't on screen. */
function splitPaneVisible(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1024px)').matches;
}

/** This device's Split View, if one is open: the main pane's Quest and the second pane's. */
function loadSplit(): { primary: string; second: string } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null') as {
      primary?: unknown;
      second?: unknown;
    } | null;
    return typeof saved?.primary === 'string' && typeof saved.second === 'string'
      ? { primary: saved.primary, second: saved.second }
      : null;
  } catch {
    return null;
  }
}

function saveSplit(split: { primary: string; second: string } | null): void {
  try {
    if (split) localStorage.setItem(SPLIT_KEY, JSON.stringify(split));
    else localStorage.removeItem(SPLIT_KEY);
  } catch {
    // Storage refused (private window): the split just won't survive a reload.
  }
}
const EMPTY_FOUND: ExternalSession[] = [];
const EMPTY_PROJECTS: Project[] = [];
