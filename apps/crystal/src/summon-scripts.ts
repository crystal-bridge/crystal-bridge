/**
 * The POSIX `sh` a Cast runs on its target (docs/SUMMONS.md). Each script arrives over stdin, so nothing depends on
 * shell quoting and nothing has to be installed there. The target keeps a job folder, which is the record:
 * `command`, `cwd`, `limit`, `runner`, `pid` (process id, process group, start time), `boot`, `turn`, `queued`, `log`,
 * `cancel` and `exit`.
 */

/** Printed to the log after `exit` is in place. It only wakes the Kingdom: `exit` is the result. */
export const FINISHED_LINE = '::summon finished';
/** Printed to the log when a job has to wait for its turn, and when it gets it. */
export const QUEUED_LINE = '::summon queued';
export const TURN_LINE = '::summon turn';
/** Printed by a start, before `started`, when the job found it has to wait. */
export const STARTED_QUEUED = 'queued';
/** Printed before a follow's log, so anything a shell startup file prints isn't taken for the log. */
export const FOLLOW_LINE = '::summon follow';

/** The scripts a Cast needs on one kind of target. */
export interface TargetScripts {
  start(id: string, command: string, cwd?: string, limit?: number): string | undefined;
  follow(id: string, offset: number): string;
  probe(id: string): string;
  cancel(id: string): string;
  clean(id: string): string;
}

function folder(id: string): string {
  return `dir="$HOME/.crystal-bridge/summons/${id}"`;
}

/** Text for a heredoc, or undefined if it holds the line that would end it. */
function delimiterFor(id: string, text: string): string | undefined {
  const delimiter = `CRYSTAL_SUMMON_${id.replaceAll('-', '')}`;
  return text.split('\n').includes(delimiter) ? undefined : delimiter;
}

/** Sets `started_at` to a process's start time; it tells a reused process id from the job's. */
const START_TIME = `
start_time() {
  if [ -r "/proc/$1/stat" ]; then
    sed 's/.*) //' "/proc/$1/stat" | cut -d' ' -f20
  else
    ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' '_'
  fi
}
`;

/** Prints something that changes each time the machine starts, or nothing where it can't be told. */
const BOOT_ID = `
boot_id() {
  cat /proc/sys/kernel/random/boot_id 2>/dev/null || sysctl -n kern.boottime 2>/dev/null
}
`;

/** Writes the exit code by renaming, so a reader never sees half of it, then wakes the Kingdom. */
const WRITE_EXIT = `
write_exit() {
  printf '%s\\n' "$1" > "$dir/exit.tmp" && mv -f "$dir/exit.tmp" "$dir/exit"
  printf '\\n${FINISHED_LINE}\\n' >> "$dir/log"
}
`;

/**
 * Runs the command under the user's login shell, then records how it ended. It leads the job's process group, so it
 * waits out a TERM aimed at the group: a trap, not an ignore, because children inherit an ignore.
 */
const RUNNER = `dir=$1
${START_TIME}${WRITE_EXIT}${BOOT_ID}
# Turns are folders that \`mkdir\` claims, which is atomic, so Kingdoms sharing a machine need no word of each other. Each
# holds its owner, so a turn left by a job that was killed, or by a reboot, is taken back.
slots="$HOME/.crystal-bridge/summons/.slots"
take_turn() {
  mkdir -p "$slots"
  limit=$(cat "$dir/limit" 2>/dev/null) || limit=1
  waiting=
  while :; do
    [ -f "$dir/cancel" ] && return 1
    n=1
    while [ "$n" -le "$limit" ]; do
      if mkdir "$slots/$n" 2>/dev/null; then
        slot="$slots/$n"
        printf '%s %s\\n' "$$" "$(start_time $$)" > "$slot/owner"
        : > "$dir/turn"
        [ -z "$waiting" ] || printf '${TURN_LINE}\\n' >> "$dir/log"
        return 0
      fi
      if [ -s "$slots/$n/owner" ] && read -r owner owner_start < "$slots/$n/owner"; then
        if ! kill -0 "$owner" 2>/dev/null || [ "$(start_time "$owner")" != "$owner_start" ]; then
          rm -rf "$slots/$n"
          continue
        fi
      fi
      n=$((n + 1))
    done
    if [ -z "$waiting" ]; then
      waiting=1
      : > "$dir/queued"
      : > "$dir/turn"
      printf '${QUEUED_LINE}\\n' >> "$dir/log"
    fi
    sleep 2
  done
}
trap ':' TERM INT HUP
boot_id > "$dir/boot"
group=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
printf '%s %s %s\\n' "$$" "\${group:-$$}" "$(start_time $$)" > "$dir/pid.tmp"
mv -f "$dir/pid.tmp" "$dir/pid"
if ! take_turn; then
  write_exit 143
  exit 0
fi
if [ -f "$dir/cwd" ] && ! cd "$(cat "$dir/cwd")" 2>>"$dir/log"; then
  rm -rf "$slot"
  write_exit 127
  exit 0
fi
"\${SHELL:-/bin/sh}" -l "$dir/command" </dev/null >>"$dir/log" 2>&1
code=$?
rm -rf "$slot"
# A job the shutdown ended has no result of its own: with no exit written, the Kingdom reports it lost. Its log line could
# reach the Kingdom before the machine goes down, so this can't wait for the boot id to change.
if [ "$code" -gt 128 ] && [ ! -f "$dir/cancel" ] && [ "$(systemctl is-system-running 2>/dev/null)" = stopping ]; then
  exit 0
fi
write_exit "$code"
`;

/** Starts a job detached and returns once it's running, printing `started`. Undefined for text it can't carry. */
export function startScript(id: string, command: string, cwd?: string, limit = 1): string | undefined {
  const delimiter = delimiterFor(id, `${command}\n${cwd ?? ''}`);
  if (!delimiter) return undefined;
  const heredoc = (file: string, text: string) => `cat > "$dir/${file}" <<'${delimiter}'\n${text}\n${delimiter}\n`;
  return `umask 077
${folder(id)}
mkdir -p "$dir" || exit 70
echo ${limit} > "$dir/limit"
${heredoc('command', command)}${cwd === undefined ? '' : heredoc('cwd', cwd)}${heredoc('runner', RUNNER)}: > "$dir/log"
# Its own process group, so a cancel reaches everything it started. macOS has no setsid.
if command -v setsid >/dev/null 2>&1; then
  setsid nohup sh "$dir/runner" "$dir" </dev/null >/dev/null 2>&1 &
elif command -v perl >/dev/null 2>&1; then
  perl -e 'use POSIX; POSIX::setsid(); exec @ARGV' nohup sh "$dir/runner" "$dir" </dev/null >/dev/null 2>&1 &
else
  set -m
  nohup sh "$dir/runner" "$dir" </dev/null >/dev/null 2>&1 &
fi
tries=0
while [ ! -s "$dir/pid" ] && [ "$tries" -lt 50 ]; do
  sleep 0.1 2>/dev/null || sleep 1
  tries=$((tries + 1))
done
[ -s "$dir/pid" ] || exit 71
# The job's first try for a turn, so a start can say it's waiting. A job this slow only goes unmentioned.
tries=0
while [ ! -f "$dir/turn" ] && [ "$tries" -lt 50 ]; do
  sleep 0.1 2>/dev/null || sleep 1
  tries=$((tries + 1))
done
[ -f "$dir/queued" ] && echo ${STARTED_QUEUED}
echo started
`;
}

/**
 * Streams the log from a byte offset. It holds stdin open for the Kingdom's side of the connection: when that goes,
 * \`cat\` ends and takes \`tail\` with it, because an idle \`tail\` would never notice by itself. The log is only ever added
 * to, so plain \`-f\` is enough and works everywhere.
 */
export function followScript(id: string, offset: number): string {
  return `${folder(id)}
printf '${FOLLOW_LINE}\\n'
tail -c +${offset + 1} -f "$dir/log" 2>/dev/null &
follower=$!
cat >/dev/null
kill "$follower" 2>/dev/null
`;
}

/**
 * Prints how the job stands, on its last line: `exit <code>` with `cancelled` if it was, `alive`, `dead` or `gone`. A
 * signal death recorded by a machine that has restarted since reads as dead: where the runner couldn't tell it was
 * shutting down, this is what's left of a job the shutdown ended.
 */
export function probeScript(id: string): string {
  return `${folder(id)}
${START_TIME}${BOOT_ID}
[ -d "$dir" ] || { echo gone; exit 0; }
state=dead
if [ -s "$dir/pid" ]; then
  read -r pid group started < "$dir/pid"
  if kill -0 "$pid" 2>/dev/null && [ "$(start_time "$pid")" = "$started" ]; then state=alive; fi
fi
# After the process check: a job ending between the two must read as ended, never as dead.
if [ -f "$dir/exit" ]; then
  code=$(cat "$dir/exit")
  state="exit $code"
  if [ -f "$dir/cancel" ]; then
    state="$state cancelled"
  elif [ "$code" -gt 128 ] && [ -s "$dir/boot" ] && [ "$(boot_id)" != "$(cat "$dir/boot")" ]; then
    state=dead
  fi
fi
echo "$state"
`;
}

/** Stops the job's group, gently and then not, and writes the exit code if the job couldn't. */
export function cancelScript(id: string): string {
  return `${folder(id)}
${START_TIME}${WRITE_EXIT}
[ -d "$dir" ] || exit 0
[ -f "$dir/exit" ] && exit 0
: > "$dir/cancel"
[ -s "$dir/pid" ] || exit 0
read -r pid group started < "$dir/pid"
[ "$(start_time "$pid")" = "$started" ] || exit 0
signal() {
  if [ "$group" = "$pid" ]; then
    kill -s "$1" -- "-$group" 2>/dev/null
  else
    pkill "-$1" -P "$pid" 2>/dev/null
    kill -s "$1" "$pid" 2>/dev/null
  fi
}
signal TERM
tries=0
while [ ! -f "$dir/exit" ] && [ "$tries" -lt 10 ]; do
  sleep 1
  tries=$((tries + 1))
done
if [ ! -f "$dir/exit" ]; then
  signal KILL
  write_exit 137
fi
`;
}

/** Removes a finished job's folder. */
export function cleanScript(id: string): string {
  return `${folder(id)}\nrm -rf "$dir"\n`;
}

export const posixScripts: TargetScripts = {
  start: startScript,
  follow: followScript,
  probe: probeScript,
  cancel: cancelScript,
  clean: cleanScript,
};
