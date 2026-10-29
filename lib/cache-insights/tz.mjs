// What "local time" means for /cache: the Pi process's time zone (TZ if set, else the OS default). Read-only:
// nothing here changes TZ, the environment, or any file.
import { display } from "./util.mjs";

const pad = (n) => String(n).padStart(2, "0");

/** Effective zone and UTC offset at `now`, and whether a TZ override is set (its value is not echoed). */
export function localZone(now = Date.now(), env = process.env) {
	let zone = "unknown";
	try {
		zone = display(Intl.DateTimeFormat().resolvedOptions().timeZone, 80) || "unknown";
	} catch {}
	const minutes = -new Date(now).getTimezoneOffset();
	const offset = Number.isFinite(minutes) ? `UTC${minutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}` : "unknown";
	return { zone, offset, override: typeof env.TZ === "string" && env.TZ !== "" };
}

export const zoneSummary = (z) => `${z.zone} (${z.offset}), ${z.override ? "set by the TZ environment variable" : "the system default"}`;

export function timezoneGuide(z) {
	return [
		`Local times in /cache use this Pi process's time zone: ${zoneSummary(z)}.`,
		"Your terminal app's own clock or time zone display does not change it; the shell, tmux, SSH session, container, or launcher that starts Pi can (through TZ).",
		"",
		"- System default: change the time zone in your operating system's Date & Time settings, then restart Pi.",
		"- One launch only (macOS/Linux shells): TZ=Asia/Tokyo pi   or   TZ=Europe/London pi",
		"- PowerShell: $env:TZ='Asia/Tokyo'; pi",
		"- Persist: add export TZ=Asia/Tokyo to your own shell profile. That affects every program started from that shell, not only Pi. Nothing is edited automatically.",
		"- Back to the system default: unset TZ, then restart Pi.",
		"",
		"Restart Pi after changing the environment it is launched from. Daylight saving time is applied automatically.",
		'UTC instead: choose UTC under Times here, or run /cache settings time utc. That only changes how /cache formats times, not your system clock or TZ.',
	].join("\n");
}
