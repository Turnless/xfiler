import type { Session } from "./types.js";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
  minute: "numeric",
  hour12: false,
});

/**
 * Label a moment relative to the US equity day (New York time).
 * regular 09:30-16:00, pre 04:00-09:30, post 16:00-20:00, overnight 20:00-04:00 Mon-Fri.
 * Weekends are "weekend". US market holidays are NOT modelled: a holiday shows up as a
 * weekday session. Whether a given token actually trades in each window is a finding of the
 * probe, not an assumption of this function.
 */
export function usSession(at: Date): Session {
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const day = parts.weekday as string;
  const hour = Number(parts.hour) % 24;
  const minutes = hour * 60 + Number(parts.minute);

  if (day === "Sat") return "weekend";
  if (day === "Sun") return minutes >= 20 * 60 ? "overnight" : "weekend";
  if (day === "Fri" && minutes >= 20 * 60) return "weekend";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "post";
  return "overnight";
}
