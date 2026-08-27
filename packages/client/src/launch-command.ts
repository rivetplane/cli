const VALUE_FLAGS = new Set(["--model", "-m", "--sandbox", "--permission-mode", "--config", "-c", "--cwd", "--directory", "--agent", "--profile", "--add-dir"]);
const BOOLEAN_FLAGS = new Set(["--no-alt-screen", "--ide", "--verbose"]);
const SESSION_FLAGS = new Set(["--resume", "-r", "--resume-id", "--session", "--session-id", "--restore", "--continue"]);
const UNSAFE_FLAGS = new Set(["--print", "-p", "--dangerously-skip-permissions", "--yolo", "--yes", "--non-interactive", "--full-auto"]);

export function sanitizeLaunchCommand(argv: string[]): string[] {
  if (argv.length === 0) throw new Error("Launch command is empty");
  const result = [argv[0]!];
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "-c" && /(?:^|[\\/])claude(?:\.exe)?$/i.test(argv[0]!)) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) || /token|secret|password|api[-_]?key|credential/i.test(arg)) { if (!arg.startsWith("--")) continue; if (!arg.includes("=")) index++; continue; }
    const [name] = arg.split("=", 1);
    if (SESSION_FLAGS.has(name!) || UNSAFE_FLAGS.has(name!)) { if (!arg.includes("=") && (VALUE_FLAGS.has(name!) || SESSION_FLAGS.has(name!))) index++; continue; }
    if (BOOLEAN_FLAGS.has(name!)) { result.push(arg); continue; }
    if (VALUE_FLAGS.has(name!)) {
      if (arg.includes("=")) { const value = arg.slice(arg.indexOf("=") + 1); if (value && !/token|secret|password|key/i.test(value)) result.push(arg); }
      else { const value = argv[index + 1]; if (value && !value.startsWith("-") && !/token|secret|password|key/i.test(value)) { result.push(arg, value); index++; } }
    }
  }
  return result;
}

export function redactLogValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, (key, item) => /token|secret|password|api[-_]?key|authorization/i.test(key) ? "[REDACTED]" : item);
  return (text ?? "").replace(/Bearer\s+[^\s",}]+/gi, "Bearer [REDACTED]").replace(/((?:token|secret|password|api[-_]?key|authorization)\s*[=:]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
}
