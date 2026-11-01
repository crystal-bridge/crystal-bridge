/**
 * The POSIX `sh` a Cast runs on its target (docs/SUMMONS.md). Each script arrives over stdin, so nothing depends on
 * shell quoting and nothing has to be installed there. The target keeps a job folder, which is the record:
 * `command`, `cwd`, `runner`, `pid` (process id, process group, start time), `log`, `cancel` and `exit`.
 */

/** Printed to the log after `exit` is in place. It only wakes the Kingdom: `exit` is the result. */
export const FINISHED_LINE = '::summon finished';
/** Printed before a follow's log, so anything a shell startup file prints isn't taken for the log. */
export const FOLLOW_LINE = '::summon follow';

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
${START_TIME}${WRITE_EXIT}
trap ':' TERM INT HUP
group=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
printf '%s %s %s\\n' "$$" "\${group:-$$}" "$(start_time $$)" > "$dir/pid.tmp"
mv -f "$dir/pid.tmp" "$dir/pid"
if [ -f "$dir/cwd" ] && ! cd "$(cat "$dir/cwd")" 2>>"$dir/log"; then
  write_exit 127
  exit 0
fi
"\${SHELL:-/bin/sh}" -l "$dir/command" </dev/null >>"$dir/log" 2>&1
write_exit $?
`;

/** Starts a job detached and returns once it's running, printing `started`. Undefined for text it can't carry. */
export function startScript(id: string, command: string, cwd?: string): string | undefined {
  const delimiter = delimiterFor(id, `${command}\n${cwd ?? ''}`);
  if (!delimiter) return undefined;
  const heredoc = (file: string, text: string) => `cat > "$dir/${file}" <<'${delimiter}'\n${text}\n${delimiter}\n`;
  return `umask 077
${folder(id)}
mkdir -p "$dir" || exit 70
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

/** Prints how the job stands, on its last line: `exit <code>` with `cancelled` if it was, `alive`, `dead` or `gone`. */
export function probeScript(id: string): string {
  return `${folder(id)}
${START_TIME}
[ -d "$dir" ] || { echo gone; exit 0; }
state=dead
if [ -s "$dir/pid" ]; then
  read -r pid group started < "$dir/pid"
  if kill -0 "$pid" 2>/dev/null && [ "$(start_time "$pid")" = "$started" ]; then state=alive; fi
fi
# After the process check: a job ending between the two must read as ended, never as dead.
if [ -f "$dir/exit" ]; then
  state="exit $(cat "$dir/exit")"
  [ -f "$dir/cancel" ] && state="$state cancelled"
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
